/**
 * チャット API エンドポイント
 * POST /api/chat でユーザーのメッセージを受け取り、
 * Claude API にストリーミングで問い合わせて結果を返す。
 */
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getAnthropicClient,
  MODEL_NAME,
  DEFAULT_MAX_TOKENS,
} from "@/lib/anthropic";
import { getSystemPrompt } from "@/lib/prompts";
import type { ChatRequest, ChatErrorResponse, Message } from "@/lib/types";

/** レート制限用：IP ごとのリクエスト時刻を記録するマップ */
const rateLimitMap = new Map<string, number[]>();

/** レート制限の設定値 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分間のウィンドウ
const RATE_LIMIT_MAX_REQUESTS = 20; // ウィンドウ内の最大リクエスト数
// レート制限マップに保持する IP バケットの最大数。攻撃者が X-Forwarded-For を
// 毎回変えて偽装すると、削除処理が無いと Map が無制限に肥大化してメモリ枯渇
// （DoS）を招く。上限を設け、超えたら最も古いバケットから捨てて有界に保つ。
const RATE_LIMIT_MAX_BUCKETS = 10_000;

/** リクエストボディ検証の上限値（トークンコスト膨張・巨大ペイロードを防ぐ） */
const MAX_MESSAGES = 50; // 1 リクエストに含められる会話メッセージ数の上限
const MAX_CONTENT_LENGTH = 8_000; // 1 メッセージあたりの本文文字数の上限

/**
 * リクエスト元のクライアント IP を推定する。
 * X-Forwarded-For は「client, proxy1, proxy2 …」のカンマ区切りで、最左が
 * 本来のクライアント。ここでは最左の 1 ホップだけを使う（末尾側は経路上の
 * プロキシで意味が薄いため）。なお XFF はクライアントが偽装可能なため、これは
 * あくまで簡易レート制限用のベストエフォートであり、確実な本人特定ではない
 * （厳密な制御は信頼できるプロキシ設定が前提になる）。
 * @param request - 受信リクエスト
 * @returns 推定したクライアント IP（取得できなければ "unknown"）
 */
function getClientIp(request: NextRequest): string {
  // X-Forwarded-For ヘッダ（カンマ区切り）を取得する
  const forwarded = request.headers.get("x-forwarded-for");
  // ヘッダが無ければ IP 不明として扱う
  if (!forwarded) {
    return "unknown";
  }
  // 最左（本来のクライアント）の 1 ホップだけを取り出して前後の空白を除く
  const first = forwarded.split(",")[0]?.trim();
  // 空文字なら不明扱い、それ以外はその値を採用する
  return first ? first : "unknown";
}

/**
 * IP ベースの簡易レート制限チェック
 * @param ip - リクエスト元の IP アドレス
 * @returns true ならレート制限超過
 */
function isRateLimited(ip: string): boolean {
  // 現在時刻を取得する
  const now = Date.now();

  // この IP の過去のリクエスト時刻一覧を取得する（なければ空配列）
  const timestamps = rateLimitMap.get(ip) ?? [];

  // ウィンドウ内のリクエストだけを残すようフィルタリングする
  const recentTimestamps = timestamps.filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  // リクエスト数が上限に達していたら制限超過と判定する
  if (recentTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    // 最新の時刻一覧を書き戻してから制限超過を返す（古い記録を溜め込まない）
    rateLimitMap.set(ip, recentTimestamps);
    return true;
  }

  // 今回のリクエスト時刻を記録する
  recentTimestamps.push(now);

  // マップを更新する
  rateLimitMap.set(ip, recentTimestamps);

  // マップが肥大化しないよう、上限を超えたら古いバケットを刈り込む
  pruneRateLimitMap(now);

  // 制限内なので false を返す
  return false;
}

/**
 * レート制限マップから不要なバケットを取り除き、メモリ使用量を有界に保つ。
 * (1) ウィンドウ外の記録しか残っていない空バケットを削除し、
 * (2) それでも上限を超える場合は挿入順（＝古い順）に捨てる。
 * @param now - 現在時刻（ミリ秒）
 */
function pruneRateLimitMap(now: number): void {
  // 上限未満なら刈り込み不要なので何もしない（毎回全走査するコストを避ける）
  if (rateLimitMap.size <= RATE_LIMIT_MAX_BUCKETS) {
    return;
  }
  // まずウィンドウ外の記録しか持たない空バケットを削除する
  for (const [ip, timestamps] of rateLimitMap) {
    // ウィンドウ内に 1 件でも残っているか判定する
    const hasRecent = timestamps.some((t) => now - t < RATE_LIMIT_WINDOW_MS);
    // ウィンドウ内の記録が無いバケットはもう不要なので削除する
    if (!hasRecent) {
      rateLimitMap.delete(ip);
    }
  }
  // それでも上限を超えるなら、挿入順（Map は挿入順を保つ）で古いものから捨てる
  while (rateLimitMap.size > RATE_LIMIT_MAX_BUCKETS) {
    // 先頭（最も古い）キーを取り出す
    const oldestKey = rateLimitMap.keys().next().value;
    // 取り出せなければループを抜ける（安全のためのガード）
    if (oldestKey === undefined) {
      break;
    }
    // 最も古いバケットを削除する
    rateLimitMap.delete(oldestKey);
  }
}

/**
 * リクエストボディが正しい形式かを検証する。
 * 不正なら理由（日本語メッセージ）を返し、正常なら null を返す。
 * @param body - パース済みのリクエストボディ（型は未検証なので実行時に確認する）
 * @returns エラーメッセージ。問題なければ null
 */
function validateChatRequest(body: ChatRequest): string | null {
  // messages が配列であることを確認する
  if (!body.messages || !Array.isArray(body.messages)) {
    return "messages フィールドが必要です。";
  }
  // 空配列は上流 API がエラーにするため、ここで弾いて明確なメッセージを返す
  if (body.messages.length === 0) {
    return "messages を 1 件以上指定してください。";
  }
  // メッセージ数の上限を超えていないか確認する（トークンコスト膨張の防止）
  if (body.messages.length > MAX_MESSAGES) {
    return `メッセージ数が多すぎます（上限 ${MAX_MESSAGES} 件）。`;
  }
  // 各メッセージの role と content を 1 件ずつ検証する
  for (const message of body.messages) {
    // role が "user" か "assistant" のいずれかであることを確認する
    if (message.role !== "user" && message.role !== "assistant") {
      return "各メッセージの role は user または assistant である必要があります。";
    }
    // content が文字列であることを確認する
    if (typeof message.content !== "string") {
      return "各メッセージの content は文字列である必要があります。";
    }
    // content が長すぎないことを確認する（1 メッセージあたりの上限）
    if (message.content.length > MAX_CONTENT_LENGTH) {
      return `メッセージが長すぎます（上限 ${MAX_CONTENT_LENGTH} 文字）。`;
    }
  }
  // すべての検証を通過したので問題なし（null）を返す
  return null;
}

/**
 * 例外を適切な HTTP ステータスとユーザー向けメッセージへ対応付ける。
 * Anthropic SDK の APIError は status（401/429/…）を持つのでそれを使う。
 * 内部詳細（スタックトレース・生のエラー文）はクライアントへ返さない（§9）。
 * @param error - 捕捉した例外
 * @returns HTTP ステータスと日本語メッセージ
 */
function toErrorResponse(error: unknown): { status: number; message: string } {
  // API キー未設定は getAnthropicClient() が投げる通常の Error なので 401 にする
  if (
    error instanceof Error &&
    error.message.includes("ANTHROPIC_API_KEY")
  ) {
    return { status: 401, message: "API キーが設定されていません。" };
  }
  // Anthropic API 由来のエラーは status コードで分類する
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    // 認証エラー（無効なキーなど）は 401
    if (error.status === 401) {
      return { status: 401, message: "API キーが無効です。" };
    }
    // レート制限は 429
    if (error.status === 429) {
      return {
        status: 429,
        message: "リクエスト数が上限を超えました。しばらくお待ちください。",
      };
    }
  }
  // それ以外は内部詳細を隠して 500 を返す
  return { status: 500, message: "サーバーエラーが発生しました。" };
}

/**
 * POST ハンドラー
 * ユーザーのチャットメッセージを受け取り、Claude API にストリーミングで転送する。
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<ChatErrorResponse> | Response> {
  try {
    // リクエスト元の IP アドレスを推定する（偽装可能なため簡易制限用）
    const ip = getClientIp(request);

    // レート制限チェックを行う
    if (isRateLimited(ip)) {
      // 制限超過の場合は 429 を返す
      return NextResponse.json(
        { error: "リクエスト数が上限を超えました。しばらくお待ちください。" },
        { status: 429 }
      );
    }

    // リクエストボディを JSON としてパースする
    const body = (await request.json()) as ChatRequest;

    // リクエストボディの形式を検証する（不正なら 400 を返す）
    const validationError = validateChatRequest(body);
    if (validationError !== null) {
      return NextResponse.json(
        { error: validationError },
        { status: 400 }
      );
    }

    // Anthropic クライアントを取得する（API キー未設定なら例外が飛ぶ）
    const client = getAnthropicClient();

    // 選択カテゴリに応じたシステムプロンプトを取得する（不正カテゴリは general にフォールバック）
    const systemPrompt = getSystemPrompt(body.category);

    // Claude API にストリーミングリクエストを送信する。
    // messages.stream() ではなく create({ stream: true }) を await することで、
    // 401/404/429 などの接続時エラーがここ（レスポンスヘッダ確定前）で throw され、
    // 下の catch で正しい HTTP ステータスに対応付けられる（stream() は同期的に
    // オブジェクトを返すためエラーが 200 送出後まで遅延し、ステータス分岐に届かない）。
    const anthropicStream = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages: body.messages.map((m: Message) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
    });

    // ストリーミングレスポンスを ReadableStream に変換する
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          // テキストデルタイベントを順次読み出す
          for await (const event of anthropicStream) {
            // content_block_delta イベントからテキスト差分を取得する
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              // テキスト差分を SSE 形式でエンコードして送信する
              const data = JSON.stringify({ text: event.delta.text });
              controller.enqueue(
                new TextEncoder().encode(`data: ${data}\n\n`)
              );
            }
          }
          // ストリーム終了を通知する
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          // ストリームを閉じる
          controller.close();
        } catch (error) {
          // ストリーム中のエラーをコントローラーに伝える
          controller.error(error);
        }
      },
      cancel() {
        // クライアントが切断したら上流の Claude リクエストも中断し、
        // 無駄なトークン消費を止める（リソースを確実に解放する。§8）。
        anthropicStream.controller.abort();
      },
    });

    // SSE レスポンスを返す
    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: unknown) {
    // 例外を HTTP ステータスと安全な日本語メッセージへ対応付ける（内部詳細は隠す）
    const { status, message } = toErrorResponse(error);

    // 分類したステータスとメッセージでエラーレスポンスを返す
    return NextResponse.json({ error: message }, { status });
  }
}
