/**
 * チャット API エンドポイント
 * POST /api/chat でユーザーのメッセージを受け取り、
 * Claude API にストリーミングで問い合わせて結果を返す。
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getAnthropicClient,
  MODEL_NAME,
  DEFAULT_MAX_TOKENS,
} from "@/lib/anthropic";
import { getSystemPrompt } from "@/lib/prompts";
import type { ChatRequest, ChatErrorResponse } from "@/lib/types";

/** レート制限用：IP ごとのリクエスト時刻を記録するマップ */
const rateLimitMap = new Map<string, number[]>();

/** レート制限の設定値 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分間のウィンドウ
const RATE_LIMIT_MAX_REQUESTS = 20; // ウィンドウ内の最大リクエスト数

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
    return true;
  }

  // 今回のリクエスト時刻を記録する
  recentTimestamps.push(now);

  // マップを更新する
  rateLimitMap.set(ip, recentTimestamps);

  // 制限内なので false を返す
  return false;
}

/**
 * POST ハンドラー
 * ユーザーのチャットメッセージを受け取り、Claude API にストリーミングで転送する。
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<ChatErrorResponse> | Response> {
  try {
    // リクエスト元の IP アドレスを取得する（取得できなければ "unknown"）
    const ip = request.headers.get("x-forwarded-for") ?? "unknown";

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

    // メッセージ配列が存在するか検証する
    if (!body.messages || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: "messages フィールドが必要です。" },
        { status: 400 }
      );
    }

    // Anthropic クライアントを取得する（API キー未設定なら例外が飛ぶ）
    const client = getAnthropicClient();

    // 選択カテゴリに応じたシステムプロンプトを取得する
    const systemPrompt = getSystemPrompt(body.category);

    // Claude API にストリーミングリクエストを送信する
    const stream = await client.messages.stream({
      model: MODEL_NAME,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages: body.messages.map((m) => ({
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
    // エラーメッセージを取得する
    const message =
      error instanceof Error ? error.message : "不明なエラーが発生しました。";

    // API キー関連のエラーなら 401 を返す
    if (message.includes("API") || message.includes("key")) {
      return NextResponse.json({ error: message }, { status: 401 });
    }

    // その他のエラーは 500 を返す
    return NextResponse.json(
      { error: "サーバーエラーが発生しました。" },
      { status: 500 }
    );
  }
}
