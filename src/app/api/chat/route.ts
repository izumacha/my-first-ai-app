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
import { getSystemPrompt, getMaxTokens, isCategoryId } from "@/lib/prompts";
import type { ChatErrorResponse, Message, Role } from "@/lib/types";

/** レート制限用：IP ごとのリクエスト時刻を記録するマップ */
const rateLimitMap = new Map<string, number[]>();

/** レート制限の設定値 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分間のウィンドウ
const RATE_LIMIT_MAX_REQUESTS = 20; // ウィンドウ内の最大リクエスト数

/** 追跡する送信元キーの上限数。X-Forwarded-For は送信元が偽装できるため、
 * 毎回異なる値を送ってマップを際限なく成長させるメモリ枯渇攻撃が成立してしまう。
 * 上限に達したら期限切れエントリを掃除し、それでも満杯なら新規送信元は
 * 共有バケットへまとめて計上して全体流量を頭打ちにする（fail-safe）。 */
const MAX_TRACKED_CLIENTS = 10_000;

/** 追跡テーブル満杯時に未追跡の新規送信元をまとめて数える共有バケットのキー。
 * IP アドレスに現れない文字で構成し、実クライアントのキーと衝突しないようにする。 */
const OVERFLOW_KEY = "__overflow__";

/** レート制限キーとして受け付ける最大文字数（IPv6 でも 45 文字以内。
 * 偽装ヘッダ由来の巨大文字列をそのままキーに使ってメモリを消費しないための上限）。 */
const MAX_CLIENT_KEY_LENGTH = 64;

/** 1 リクエストで受け付ける会話履歴の最大メッセージ数（無制限の履歴送信による
 * トークン浪費・リソース枯渇を防ぐ。通常のチャット利用では到達しない値）。 */
const MAX_MESSAGE_COUNT = 50;

/** 1 メッセージ本文の最大文字数（巨大ボディをそのまま Claude へ転送して
 * 課金・メモリを浪費させられないようにする入力上限）。 */
const MAX_CONTENT_LENGTH = 4000;

/** メッセージのロールとして受け付ける値の一覧（未知のロールを Claude へ転送しない） */
const ALLOWED_ROLES: readonly Role[] = ["user", "assistant"];

/**
 * リクエストヘッダから送信元を識別するキーを解決する。
 * X-Forwarded-For は信頼できるプロキシ（Vercel 等のホスティング基盤）が設定する前提で
 * 先頭のクライアント IP を採用する。直接公開する構成ではヘッダを偽装できるため、
 * 上のマップ上限（MAX_TRACKED_CLIENTS）と共有バケットで資源枯渇を防いでいる。
 * @param request - 受信リクエスト
 * @returns レート制限のキーとして使う文字列
 */
function resolveClientKey(request: NextRequest): string {
  // X-Forwarded-For ヘッダを取得する（無ければ null）
  const forwarded = request.headers.get("x-forwarded-for");
  // カンマ区切りの先頭要素（クライアント IP）を取り出し、前後の空白を除去する
  const first = forwarded?.split(",")[0]?.trim();
  // 空・過剰な長さのキーは不正値とみなし共通の "unknown" に倒す（キー長でのメモリ消費も防ぐ）
  if (!first || first.length > MAX_CLIENT_KEY_LENGTH) {
    return "unknown";
  }
  // 妥当な長さのクライアント IP をキーとして返す
  return first;
}

/**
 * IP ベースの簡易レート制限チェック
 * @param clientKey - リクエスト元を識別するキー
 * @returns true ならレート制限超過
 */
function isRateLimited(clientKey: string): boolean {
  // 現在時刻を取得する
  const now = Date.now();

  // 追跡テーブルが上限に達していたら、期限切れの送信元エントリをまとめて掃除する
  if (rateLimitMap.size >= MAX_TRACKED_CLIENTS) {
    // すべてのエントリを確認して、ウィンドウ外のものだけを削除する
    for (const [key, timestamps] of rateLimitMap) {
      // 最後のリクエストがウィンドウ外なら、この送信元の記録は不要なので削除する
      if (timestamps.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) {
        rateLimitMap.delete(key);
      }
    }
  }

  // 掃除後も満杯で、かつ未追跡の新規送信元なら共有バケットに振り替える。
  // 素通しにすると偽装キーの使い捨てで制限を無効化できてしまうため、
  // 満杯時の新規送信元はまとめて数えて全体流量を必ず頭打ちにする（fail-safe）
  const effectiveKey =
    rateLimitMap.size >= MAX_TRACKED_CLIENTS && !rateLimitMap.has(clientKey)
      ? OVERFLOW_KEY
      : clientKey;

  // この送信元の過去のリクエスト時刻一覧を取得する（なければ空配列）
  const timestamps = rateLimitMap.get(effectiveKey) ?? [];

  // ウィンドウ内のリクエストだけを残すようフィルタリングする
  const recentTimestamps = timestamps.filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  // リクエスト数が上限に達していたら制限超過と判定する
  if (recentTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  // 今回のリクエスト時刻を記録する
  recentTimestamps.push(now);

  // マップを更新する
  rateLimitMap.set(effectiveKey, recentTimestamps);

  // 制限内なので false を返す
  return false;
}

/**
 * リクエストボディの messages を検証し、問題があれば日本語のエラーメッセージを返す。
 * 形だけの配列チェックでは巨大な本文・未知のロール・空配列がそのまま Claude へ
 * 転送されてしまうため、境界（件数・文字数・型）まで検証する（§セキュリティ: 入力は信用しない）。
 * @param messages - リクエスト由来の未検証の値
 * @returns エラーメッセージ（問題なければ null）
 */
function validateMessages(messages: unknown): string | null {
  // 配列でない場合は形式エラーとする
  if (!Array.isArray(messages)) {
    return "messages フィールドが必要です。";
  }
  // 空配列は Claude API 側でエラーになるため、ここで 400 として弾く
  if (messages.length === 0) {
    return "メッセージを 1 件以上指定してください。";
  }
  // 件数上限を超える履歴は受け付けない（トークン浪費・リソース枯渇防止）
  if (messages.length > MAX_MESSAGE_COUNT) {
    return `メッセージ数が上限（${MAX_MESSAGE_COUNT} 件）を超えています。`;
  }
  // 各メッセージの中身（ロール・本文）を検証する
  for (const message of messages) {
    // オブジェクトでない要素（null・文字列など）は形式エラーとする
    if (typeof message !== "object" || message === null) {
      return "メッセージの形式が正しくありません。";
    }
    // 検証のためにロールと本文を取り出す（この時点では未検証の unknown として扱う）
    const { role, content } = message as { role?: unknown; content?: unknown };
    // ロールが許可リストに無い場合は弾く（"system" 等を Claude へ転送させない）
    if (!ALLOWED_ROLES.includes(role as Role)) {
      return "メッセージのロールが正しくありません。";
    }
    // 本文が文字列でない・空文字列の場合は弾く
    if (typeof content !== "string" || content.trim() === "") {
      return "メッセージ本文を入力してください。";
    }
    // 本文が上限文字数を超える場合は弾く（巨大ボディの転送防止）
    if (content.length > MAX_CONTENT_LENGTH) {
      return `メッセージ本文が上限（${MAX_CONTENT_LENGTH} 文字）を超えています。`;
    }
  }
  // すべての検証を通過したら問題なし（null）を返す
  return null;
}

/**
 * POST ハンドラー
 * ユーザーのチャットメッセージを受け取り、Claude API にストリーミングで転送する。
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<ChatErrorResponse> | Response> {
  try {
    // リクエスト元を識別するキーを取得する
    const clientKey = resolveClientKey(request);

    // レート制限チェックを行う
    if (isRateLimited(clientKey)) {
      // 制限超過の場合は 429 を返す
      return NextResponse.json(
        { error: "リクエスト数が上限を超えました。しばらくお待ちください。" },
        { status: 429 }
      );
    }

    // リクエストボディを JSON としてパースする（壊れた JSON は 400 として弾く）
    let body: { messages?: unknown; category?: unknown };
    try {
      // JSON パースを試みる（unknown として受け取り、この後の検証で絞り込む）
      body = (await request.json()) as { messages?: unknown; category?: unknown };
    } catch {
      // JSON として不正なボディは 400（クライアント起因のエラー）を返す
      return NextResponse.json(
        { error: "リクエストボディが正しい JSON ではありません。" },
        { status: 400 }
      );
    }

    // メッセージ配列を検証する（件数・ロール・本文の型と長さまで確認する）
    const validationError = validateMessages(body.messages);
    // 検証エラーがあれば 400 を返す
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // 検証を通過したメッセージ配列を型付きで取り出す
    const messages = body.messages as Message[];

    // カテゴリは既知の ID のみ採用する（未知の値は undefined として general に倒す）
    const category = isCategoryId(body.category) ? body.category : undefined;

    // Anthropic クライアントを取得する（API キー未設定なら例外が飛ぶ）
    const client = getAnthropicClient();

    // 選択カテゴリに応じたシステムプロンプトを取得する
    const systemPrompt = getSystemPrompt(category);

    // Claude API にストリーミングリクエストを送信する
    const stream = await client.messages.stream({
      model: MODEL_NAME,
      // カテゴリ別の上書き設定があればそれを、なければ既定値を使う
      max_tokens: getMaxTokens(category, DEFAULT_MAX_TOKENS),
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    // ストリーミングレスポンスを ReadableStream に変換する
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          // テキストデルタイベントを順次読み出す
          for await (const event of stream) {
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
    // Anthropic SDK の型付きエラーはステータスコードで分類する。
    // 旧実装のメッセージ文字列への部分一致（"API"/"key"）は、上流の 429 を 500 に
    // 誤分類し、逆に 401 では英語の内部エラーメッセージをそのまま外部へ漏らしていた
    if (error instanceof Anthropic.APIError) {
      // 認証エラー（API キー無効等）は 401 と日本語の安全な文言を返す
      if (error.status === 401) {
        return NextResponse.json(
          { error: "API キーが無効です。設定を確認してください。" },
          { status: 401 }
        );
      }
      // 上流のレート制限（429）はそのまま 429 として返す（CLAUDE.md のステータス契約）
      if (error.status === 429) {
        return NextResponse.json(
          { error: "リクエスト数が上限を超えました。しばらくお待ちください。" },
          { status: 429 }
        );
      }
    }

    // API キー未設定（getAnthropicClient が投げる日本語メッセージの例外）は 401 を返す
    if (
      error instanceof Error &&
      error.message.includes("ANTHROPIC_API_KEY")
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    // 想定外のエラーは詳細をサーバログにだけ残す（内部情報を外部へ返さない）
    console.error("チャット API で想定外のエラーが発生しました:", error);

    // その他のエラーは 500 と汎用の安全な文言を返す
    return NextResponse.json(
      { error: "サーバーエラーが発生しました。" },
      { status: 500 }
    );
  }
}
