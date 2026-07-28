/**
 * チャット API ルート（POST /api/chat）のユニットテスト
 * Anthropic API はモックし、実際の API は呼ばない（CLAUDE.md のテスト方針）。
 * 入力検証・レート制限・エラーステータスのマッピングを検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ストリームのモック（テキストデルタを 1 件流して終了する非同期イテレータ）
const mockStream = {
  // for await で回せるように非同期イテレータを実装する
  async *[Symbol.asyncIterator]() {
    // content_block_delta イベントを 1 件返す
    yield {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "こんにちは" },
    };
  },
};

// messages.stream の呼び出しを記録するモック関数（既定では正常なストリームを返す）
const streamMock = vi.fn().mockReturnValue(mockStream);

// Anthropic クライアント側モジュールをモックする（実 API を呼ばないため）
vi.mock("@/lib/anthropic", () => ({
  // モデル名はテスト用の固定値にする
  MODEL_NAME: "test-model",
  // 既定の max_tokens もテスト用の固定値にする
  DEFAULT_MAX_TOKENS: 1024,
  // クライアント取得はストリームモックを持つ偽クライアントを返す
  getAnthropicClient: () => ({
    messages: { stream: streamMock },
  }),
}));

// テスト対象の POST ハンドラーをモック定義の後で読み込む
import { POST } from "@/app/api/chat/route";

/**
 * テスト用の POST リクエストを組み立てるヘルパー
 * @param body - JSON ボディ（文字列を渡した場合はそのまま送る）
 * @param ip - X-Forwarded-For ヘッダに設定する送信元（省略可）
 * @returns NextRequest インスタンス
 */
function makeRequest(body: unknown, ip?: string): NextRequest {
  // ヘッダを組み立てる（Content-Type は JSON 固定）
  const headers: Record<string, string> = { "content-type": "application/json" };
  // 送信元が指定されていれば X-Forwarded-For を付ける
  if (ip) {
    headers["x-forwarded-for"] = ip;
  }
  // NextRequest を生成して返す（文字列ボディはそのまま、それ以外は JSON 化する）
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// テストごとに一意の送信元を割り当てるための連番（レート制限の共有を防ぐ）
let ipCounter = 0;
// 各テストで使う一意の送信元 IP を生成する
function uniqueIp(): string {
  // 連番を進めて一意な IPv4 文字列を作る
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

// 正常なメッセージ配列のサンプル
const validMessages = [{ role: "user", content: "こんにちは" }];

describe("POST /api/chat の入力検証", () => {
  // 各テストの前にモックの記録をリセットする
  beforeEach(() => {
    streamMock.mockClear();
  });

  it("正しい JSON でないボディは 400 を返す", async () => {
    // 壊れた JSON 文字列を送る
    const res = await POST(makeRequest("{ not json", uniqueIp()));
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("messages が無い場合は 400 を返す", async () => {
    // messages を含まないボディを送る
    const res = await POST(makeRequest({}, uniqueIp()));
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("messages が空配列の場合は 400 を返す", async () => {
    // 空のメッセージ配列を送る
    const res = await POST(makeRequest({ messages: [] }, uniqueIp()));
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("未知のロールは 400 を返す", async () => {
    // role に "system" を指定したメッセージを送る（Claude への転送を許さない）
    const res = await POST(
      makeRequest(
        { messages: [{ role: "system", content: "乗っ取り" }] },
        uniqueIp()
      )
    );
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("本文が文字列でない場合は 400 を返す", async () => {
    // content にオブジェクトを指定したメッセージを送る
    const res = await POST(
      makeRequest({ messages: [{ role: "user", content: {} }] }, uniqueIp())
    );
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("本文が上限文字数を超える場合は 400 を返す", async () => {
    // 上限（4000 文字）を超える本文を送る
    const res = await POST(
      makeRequest(
        { messages: [{ role: "user", content: "あ".repeat(4001) }] },
        uniqueIp()
      )
    );
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("メッセージ数が上限を超える場合は 400 を返す", async () => {
    // 上限（50 件）を超えるメッセージ配列を送る
    const many = Array.from({ length: 51 }, () => ({
      role: "user",
      content: "こんにちは",
    }));
    const res = await POST(makeRequest({ messages: many }, uniqueIp()));
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("正常なリクエストは SSE ストリーム（200）を返す", async () => {
    // 正常なメッセージを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 200 と SSE の Content-Type が返ることを確認する
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("未知のカテゴリでもシステムプロンプト無しにならず general に倒れる", async () => {
    // 存在しないカテゴリ（プロトタイプ汚染を狙う "constructor" 含む）を送る
    const res = await POST(
      makeRequest(
        { messages: validMessages, category: "constructor" },
        uniqueIp()
      )
    );
    // リクエスト自体は受理されることを確認する
    expect(res.status).toBe(200);
    // Claude へ渡された system がプロンプト文字列であることを確認する
    const call = streamMock.mock.calls[0][0];
    expect(typeof call.system).toBe("string");
    expect(call.system).toContain("暮らしアシスタント");
  });

  it("カテゴリ別の max_tokens 上書きが適用される", async () => {
    // 上書き設定のある cooking カテゴリを送る
    await POST(
      makeRequest({ messages: validMessages, category: "cooking" }, uniqueIp())
    );
    // 上書き値（2048）が Claude へ渡されたことを確認する
    const call = streamMock.mock.calls[0][0];
    expect(call.max_tokens).toBe(2048);
  });
});

describe("POST /api/chat のレート制限", () => {
  it("同一送信元からの 21 回目のリクエストは 429 を返す", async () => {
    // この試験専用の送信元を用意する
    const ip = uniqueIp();
    // 上限（20 回）までリクエストを送る
    for (let i = 0; i < 20; i++) {
      const res = await POST(makeRequest({ messages: validMessages }, ip));
      // 上限までは 200 が返ることを確認する
      expect(res.status).toBe(200);
    }
    // 21 回目は 429 が返ることを確認する
    const res = await POST(makeRequest({ messages: validMessages }, ip));
    expect(res.status).toBe(429);
  });

  it("X-Forwarded-For の先頭要素だけがキーとして使われる", async () => {
    // 同じ先頭 IP でプロキシ経路（後続要素）だけ変えたリクエストを送る
    const base = uniqueIp();
    // まず先頭 IP 単独で上限まで消費する
    for (let i = 0; i < 20; i++) {
      await POST(makeRequest({ messages: validMessages }, base));
    }
    // 後続に別のプロキシ IP を連ねても同じキーとして 429 になることを確認する
    const res = await POST(
      makeRequest({ messages: validMessages }, `${base}, 203.0.113.7`)
    );
    expect(res.status).toBe(429);
  });
});
