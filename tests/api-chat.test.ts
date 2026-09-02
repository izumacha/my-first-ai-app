/**
 * チャット API ルート（POST /api/chat）のユニットテスト
 * Anthropic API はモックし、実際の API は呼ばない（CLAUDE.md のテスト方針）。
 * 入力検証・レート制限・エラーステータスのマッピングを検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
// 上流エラーマッピングの試験で SDK の型付きエラーを生成するために読み込む
import Anthropic from "@anthropic-ai/sdk";

// ストリームのモックを生成する（テキストデルタを 1 件流して正常終了する非同期イテレータ）。
// 実 SDK の Stream と同じく、中断用の AbortController 互換オブジェクト（controller）を持つ。
// 最後に message_delta で終了理由を伝えるのは実際の上流と同じ挙動に合わせるため
// （実ストリームは必ず終了理由を伝えて終わる）。これを省いたモックは
// 「本文が途中で途切れたストリーム」を模していることになり、正常系の試験にならない
function makeMockStream() {
  return {
    // クライアント切断時に route が呼ぶ中断用コントローラ（呼び出しを記録する）
    controller: { abort: vi.fn() },
    // for await で回せるように非同期イテレータを実装する
    async *[Symbol.asyncIterator]() {
      // content_block_delta イベントを 1 件返す
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "こんにちは" },
      };
      // 最後まで話し終えたことを伝えるイベントを返す
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      };
    },
  };
}

/**
 * 「差分を 1 件流したあとに失敗する」ストリームのモックを生成する。
 * 接続確立後（＝ 200 とヘッダを返し終えたあと）にだけ起きる失敗を再現するために使う。
 * @param failure - 反復の途中で投げるエラー
 * @returns 1 件流してから failure を投げる、中断用コントローラ付きのモックストリーム
 */
function makeFailingStream(failure: unknown) {
  return {
    // クライアント切断時に route が呼ぶ中断用コントローラ（呼び出しを記録する）
    controller: { abort: vi.fn() },
    // 1 件流してから失敗する非同期イテレータを実装する
    async *[Symbol.asyncIterator]() {
      // 正常なデルタを 1 件返す
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "こん" },
      };
      // 反復の途中で指定されたエラーを投げる
      throw failure;
    },
  };
}

/**
 * 実 SDK と同じく「中断されたら throw せず正常終了する」ストリームのモックを生成する。
 * 実 SDK（core/streaming.js）の反復子は abort を捕まえて return するため、
 * 受信側が切断しても route の for-await は例外を出さずに抜ける。
 * @param options - `failWhenAborted` を渡すと、中断されたあとに静かに終わる代わりに
 *                  そのエラーを投げる（切断と上流障害が同時に起きる状況の再現に使う）。
 *                  `deltasAfterAbort` を渡すと、中断後もその件数だけデルタを流し続ける
 *                  （上流がまだ切断に気づいていない状況の再現に使う）
 * @returns 1 件流したあと、中断されるまで待って終わるモックストリーム
 */
function makeAbortAwareStream(
  options: { failWhenAborted?: unknown; deltasAfterAbort?: number } = {}
) {
  // 中断が要求されたかどうかを保持するフラグ
  let aborted = false;
  return {
    // route が呼ぶ中断用コントローラ（呼び出しを記録しつつフラグを立てる）
    controller: {
      abort: vi.fn(() => {
        // 中断が要求されたことを記録する
        aborted = true;
      }),
    },
    // 1 件流したあと、中断されるまで待ってから静かに終わる非同期イテレータ
    async *[Symbol.asyncIterator]() {
      // 正常なデルタを 1 件返す
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "こん" },
      };
      // 中断されるまで待つ（実 SDK が上流の受信を待っている状態に相当する）
      while (!aborted) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // 中断後もデルタを流し続ける指定があれば、その件数だけ流す
      // （上流がまだ切断に気づいていない状況に相当する）
      for (let i = 0; i < (options.deltasAfterAbort ?? 0); i += 1) {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "にちは" },
        };
      }
      // 上流障害を同時に起こす指定があれば、そのエラーを投げる
      if (options.failWhenAborted !== undefined) {
        throw options.failWhenAborted;
      }
      // 指定が無ければ throw せずに終了する（実 SDK の中断時と同じ挙動）
    },
  };
}

/**
 * ストリームを最後まで（またはエラーになるまで）読み進める。
 * 反復中のエラーは start() の中で起きるため、ボディを実際に読まないと表面化しない。
 * @param body - 読み進めるレスポンスボディ
 */
async function drainBody(body: ReadableStream<Uint8Array>): Promise<void> {
  // 読み取り口を取得する
  const reader = body.getReader();
  // 終端（done）に達するまで読み続ける。エラーがあればここで reject する
  while (!(await reader.read()).done) {
    // 読み取り継続（終端またはエラー到達待ち）
  }
}

// messages.create の呼び出しを記録するモック関数（既定では正常なストリームで解決する）。
// 実 SDK の create({stream:true}) は「上流の HTTP 応答を受けてから」解決する Promise を
// 返すため、モックも同期 return ではなく Promise で解決／拒否させて実挙動に合わせる
const createMock = vi.fn().mockImplementation(() =>
  Promise.resolve(makeMockStream())
);

// getAnthropicClient の振る舞いを差し替えるためのフック。null なら既定の偽クライアントを返す。
// API キー未設定など「クライアント取得そのものが失敗する」経路を試験するために使う
let getClientOverride: (() => unknown) | null = null;

// Anthropic クライアント側モジュールをモックする（実 API を呼ばないため）
vi.mock("@/lib/anthropic", async (importOriginal) => {
  // MissingApiKeyError は route 側が instanceof で判定する型なので、
  // 偽物を作らず実物を読み込んで共有する（型が食い違うと判定が通らずテストが無意味になる）
  const actual = await importOriginal<typeof import("@/lib/anthropic")>();
  return {
    // API キー未設定エラーの実クラスをそのまま再エクスポートする
    MissingApiKeyError: actual.MissingApiKeyError,
    // モデル名はテスト用の固定値にする
    MODEL_NAME: "test-model",
    // 既定の max_tokens もテスト用の固定値にする
    DEFAULT_MAX_TOKENS: 1024,
    // クライアント取得は、差し替えがあればそれを、無ければストリーミング作成モックを持つ偽クライアントを返す
    getAnthropicClient: () =>
      getClientOverride
        ? getClientOverride()
        : { messages: { create: createMock } },
  };
});

// テストから実クラスを参照するために、モック定義の後で実モジュールを読み込む
import { MissingApiKeyError } from "@/lib/anthropic";

// テスト対象の POST ハンドラーをモック定義の後で読み込む
import { POST } from "@/app/api/chat/route";
// 完了の番兵（送信側と読み取り側で共有する定数）
import { SSE_DONE_MARKER } from "@/lib/sse";
// ボディサイズ上限（定義元は @/lib/chat-limits）。テストへ数値を書き写すと、
// 上限を変えたときにテストだけが古い値を見たまま緑になる
import { MAX_BODY_BYTES } from "@/lib/chat-limits";

/**
 * テスト用の POST リクエストを組み立てるヘルパー
 * @param body - JSON ボディ（文字列を渡した場合はそのまま送る）
 * @param ip - X-Forwarded-For ヘッダに設定する送信元（省略可）
 * @param contentType - Content-Type ヘッダの値（省略時は JSON、null なら付けない）
 * @returns NextRequest インスタンス
 */
function makeRequest(
  body: unknown,
  ip?: string,
  contentType: string | null = "application/json",
  signal?: AbortSignal
): NextRequest {
  // ヘッダを組み立てる（既定では Content-Type に JSON を指定する）
  const headers: Record<string, string> = {};
  // Content-Type の指定があればヘッダに載せる（null のときは意図的に省略する）
  if (contentType !== null) {
    headers["content-type"] = contentType;
  }
  // 送信元が指定されていれば X-Forwarded-For を付ける
  if (ip) {
    headers["x-forwarded-for"] = ip;
  }
  // NextRequest を生成して返す（文字列ボディはそのまま、それ以外は JSON 化する）
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    // 中断シグナルの指定があれば渡す（プラットフォーム側の中断を再現するのに使う）
    signal,
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
    createMock.mockClear();
  });

  it("正しい JSON でないボディは 400 を返す", async () => {
    // 壊れた JSON 文字列を送る
    const res = await POST(makeRequest("{ not json", uniqueIp()));
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
  });

  it("JSON ボディが null リテラルでも 400 を返す（500 にしない）", async () => {
    // JSON として正しくてもオブジェクトとは限らない。とくに "null" は
    // JSON.parse が null を返すため、そのまま body.messages を読むと TypeError に
    // なり、入力の誤りが 500 と「想定外のエラー」のサーバログに化ける
    // （認証の無いエンドポイントなので、誰でもサーバログを増やせてしまう）。
    // 数値・文字列・配列など他の非オブジェクトは .messages が undefined になり
    // messages の検証で 400 になるので、ここで区別して並べる意味は無い
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": uniqueIp(),
      },
      body: "null",
    });
    // 入力検証の誤りとして 400 が返ることを確認する
    const res = await POST(req);
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

  it("assistant 発言で始まる履歴は上流を呼ばずに 400 を返す", async () => {
    // 上流 Claude は「最初のメッセージが user ロール」であることを要求するため、
    // この形は必ず上流で 400 になる。画面側（trimHistoryForRequest）は窓の先頭を
    // user にそろえて防いでいるが、保証を送信側だけに置くと、画面以外の
    // 呼び出し元では消えてしまう（入力を信用しない境界はサーバー側）
    const res = await POST(
      makeRequest(
        { messages: [{ role: "assistant", content: "回答" }] },
        uniqueIp()
      )
    );
    // 400 が返ることを確認する
    expect(res.status).toBe(400);
    // 上流を 1 往復むだに呼んでいないことを確認する（課金と待ち時間が発生する）
    expect(createMock).not.toHaveBeenCalled();
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
    const call = createMock.mock.calls[0][0];
    expect(typeof call.system).toBe("string");
    expect(call.system).toContain("暮らしアシスタント");
  });

  it("カテゴリ別の max_tokens 上書きが適用される", async () => {
    // 上書き設定のある cooking カテゴリを送る
    await POST(
      makeRequest({ messages: validMessages, category: "cooking" }, uniqueIp())
    );
    // 上書き値（2048）が Claude へ渡されたことを確認する
    const call = createMock.mock.calls[0][0];
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

  it("X-Forwarded-For は末尾要素（信頼できる直近プロキシの追記分）がキーとして使われる", async () => {
    // 末尾（実際の接続元）を固定し、先頭（クライアントが偽装できる部分）だけ変えたリクエストを送る
    const base = uniqueIp();
    // まず末尾 IP 単独で上限まで消費する
    for (let i = 0; i < 20; i++) {
      await POST(makeRequest({ messages: validMessages }, base));
    }
    // 先頭に偽装 IP を連ねても末尾が同じなら同一キーとして 429 になることを確認する
    const res = await POST(
      makeRequest({ messages: validMessages }, `203.0.113.7, ${base}`)
    );
    expect(res.status).toBe(429);
  });

  it("X-Real-IP があれば X-Forwarded-For より優先してキーに使われる", async () => {
    // この試験専用の実 IP（X-Real-IP）を用意する
    const realIp = uniqueIp();
    // X-Real-IP を固定しつつ X-Forwarded-For を毎回変えて上限まで消費する
    for (let i = 0; i < 20; i++) {
      // ヘッダを個別に組み立てる（XFF は毎回異なる偽装値）
      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": realIp,
          "x-forwarded-for": `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ messages: validMessages }),
      });
      // 上限までは 200 が返ることを確認する
      const res = await POST(req);
      expect(res.status).toBe(200);
    }
    // XFF を変えても X-Real-IP が同じなら 21 回目は 429 になることを確認する
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": realIp,
        "x-forwarded-for": "198.51.100.250",
      },
      body: JSON.stringify({ messages: validMessages }),
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it("429 応答には Retry-After ヘッダが付く", async () => {
    // この試験専用の送信元を用意する
    const ip = uniqueIp();
    // 上限まで消費する
    for (let i = 0; i < 20; i++) {
      await POST(makeRequest({ messages: validMessages }, ip));
    }
    // 21 回目の 429 応答を取得する
    const res = await POST(makeRequest({ messages: validMessages }, ip));
    // 429 であることを確認する
    expect(res.status).toBe(429);
    // Retry-After がウィンドウ秒数（60）で付いていることを確認する
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("POST /api/chat のボディサイズ上限", () => {
  it("Content-Length が上限を超えるリクエストは 413 を返す", async () => {
    // 小さいボディに巨大な Content-Length を申告したリクエストを組み立てる
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": uniqueIp(),
        // 上限を超える値を申告する（値は定数から導く）
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      body: JSON.stringify({ messages: validMessages }),
    });
    // パース前に 413 で弾かれることを確認する
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("Content-Length の申告が無い巨大ボディも実測で 413 を返す", async () => {
    // チャンク転送を模した「Content-Length 無し」の巨大ボディ（上限超）を作る。
    // 長さは定数から導く（書き写すと、上限を上げたときにこの試験だけが
    // 上限内のボディを送るようになり、413 の経路を検証しなくなる）
    const hugeBody = JSON.stringify({
      messages: [{ role: "user", content: "a".repeat(MAX_BODY_BYTES + 100_000) }],
    });
    // fetch 互換の Request 構築ではヘッダに content-length が自動付与されないため、
    // ヘッダ検査だけの実装ではこのリクエストが素通りしてしまう（実測チェックの回帰防止）
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": uniqueIp(),
      },
      body: hugeBody,
    });
    // ヘッダ申告に依存せず、実際の読み取りバイト数で 413 になることを確認する
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});

describe("POST /api/chat の Content-Type 検証", () => {
  // 各テストの前にモックの記録をリセットする
  beforeEach(() => {
    createMock.mockClear();
  });

  it("Content-Type が無いリクエストは 415 を返す", async () => {
    // Content-Type を付けずに正しい JSON を送る（simple request を模す）
    const res = await POST(
      makeRequest({ messages: validMessages }, uniqueIp(), null)
    );
    // JSON 以外は受け付けないので 415 が返ることを確認する
    expect(res.status).toBe(415);
    // 上流 Claude API が一度も呼ばれていない（課金が発生しない）ことを確認する
    expect(createMock).not.toHaveBeenCalled();
  });

  it("text/plain のリクエストは 415 を返す", async () => {
    // HTML フォームから送れる text/plain で、中身は正しい JSON のリクエストを作る。
    // これを通すと第三者サイトから preflight 無しで課金リクエストを誘発できてしまう
    const res = await POST(
      makeRequest({ messages: validMessages }, uniqueIp(), "text/plain")
    );
    // 415 で弾かれることを確認する
    expect(res.status).toBe(415);
    // 上流 Claude API が一度も呼ばれていないことを確認する
    expect(createMock).not.toHaveBeenCalled();
  });

  it("charset パラメータ付きの application/json は受け付ける", async () => {
    // ブラウザや HTTP クライアントが付けがちな charset 付きの Content-Type を送る
    const res = await POST(
      makeRequest(
        { messages: validMessages },
        uniqueIp(),
        "application/json; charset=utf-8"
      )
    );
    // パラメータ部を無視して MIME タイプ本体で判定するため 200 になることを確認する
    expect(res.status).toBe(200);
  });

  it("415 で弾かれたリクエストはレート制限の枠を消費しない", async () => {
    // この試験専用の送信元を用意する
    const ip = uniqueIp();

    // 第三者サイトから被害者のブラウザ経由で simple request を浴びせる状況を模して、
    // 上限（20 回）を超える回数だけ Content-Type 不正のリクエストを送る
    for (let i = 0; i < 25; i++) {
      // 中身は正しい JSON だが Content-Type が text/plain のリクエストを送る
      const res = await POST(
        makeRequest({ messages: validMessages }, ip, "text/plain")
      );
      // すべて 415 で弾かれる（レート制限の 429 にはならない）ことを確認する
      expect(res.status).toBe(415);
    }

    // 同じ送信元から正規のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, ip));
    // 枠が消費されていないため、本人は通常どおり利用できる（429 にならない）ことを確認する
    expect(res.status).toBe(200);
  });
});

describe("POST /api/chat のストリーミング応答", () => {
  // 各テストの前にモックの記録と実装をリセットする
  beforeEach(() => {
    createMock.mockClear();
    createMock.mockImplementation(() => Promise.resolve(makeMockStream()));
  });

  it("上流呼び出しにタイムアウトが指定される", async () => {
    // 正常な形のリクエストを送る
    await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // create の第 2 引数（リクエストオプション）を取り出す
    const options = createMock.mock.calls[0][1] as { timeout?: number };
    // 応答しない上流に接続を占有され続けないよう上限が設定されていることを確認する
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("逆プロキシのバッファリングを無効化するヘッダが付く", async () => {
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // SSE として返っていることを確認する
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // nginx 等がバッファリングして逐次表示にならない問題を防ぐヘッダを確認する
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
  });
});

describe("POST /api/chat の上流エラーマッピング", () => {
  // 各テストの前にモックの記録と実装をリセットする
  beforeEach(() => {
    createMock.mockClear();
    createMock.mockImplementation(() => Promise.resolve(makeMockStream()));
  });

  /**
   * 指定ステータスの Anthropic SDK 型付きエラーで reject するモックを 1 回だけ仕込む。
   * 実 SDK の create({stream:true}) はエラーを「throw」ではなく Promise の reject として
   * 返すため、モックも同じ非同期経路で失敗させる（同期 throw のモックでは、実経路で
   * 到達不能なコードをテストが通してしまう回帰があった）。
   * @param status - 上流の HTTP ステータスコード
   * @param type - Anthropic エラー種別文字列
   */
  function rejectOnceWithApiError(status: number, type: string): void {
    // 指定ステータスの具象エラークラスで reject する実装を 1 回だけ設定する
    createMock.mockImplementationOnce(() =>
      Promise.reject(
        // APIError.generate はステータスに応じた具象エラークラスを生成する
        Anthropic.APIError.generate(
          status,
          { error: { type, message: "upstream error" } },
          "upstream error",
          new Headers()
        )
      )
    );
  }

  it("上流 Anthropic の 400 はクライアントエラー（400）として返す", async () => {
    // 上流でだけ 400 になるモックを仕込む
    rejectOnceWithApiError(400, "invalid_request_error");
    // 正常な形のリクエストを送る（上流でだけ 400 になる想定）
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 500 ではなく 400 が返ることを確認する
    expect(res.status).toBe(400);
    // 内部メッセージ（英語）ではなく安全な日本語文言が返ることを確認する
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("リクエストの内容が不正です");
  });

  it("上流 Anthropic の 401（API キー無効）は 401 と安全な文言を返す", async () => {
    // 上流でだけ 401 になるモックを仕込む
    rejectOnceWithApiError(401, "authentication_error");
    // 正常な形のリクエストを送る（API キーが無効な想定）
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 200 のストリームではなく 401 が返ることを確認する（旧実装はここが 200 になっていた）
    expect(res.status).toBe(401);
    // 内部メッセージではなく安全な日本語文言が返ることを確認する
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("API キーが無効です");
  });

  it("API キー未設定（MissingApiKeyError）は 401 を返し、環境変数名を応答に漏らさない", async () => {
    // クライアント取得そのものが API キー未設定で失敗する状況を作る
    getClientOverride = () => {
      throw new MissingApiKeyError();
    };
    // console.error でのサーバログ出力を握って、テスト出力を汚さず呼び出しも検証できるようにする
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る（サーバ側の設定漏れだけが原因の想定）
      const res = await POST(
        makeRequest({ messages: validMessages }, uniqueIp())
      );
      // 500 ではなく 401 が返ることを確認する（CLAUDE.md のステータス契約）
      expect(res.status).toBe(401);
      // 応答ボディを読み取る
      const body = (await res.json()) as { error: string };
      // 一元管理された安全な日本語文言が返ることを確認する
      expect(body.error).toBe("API キーが無効です。設定を確認してください。");
      // サーバ側の環境変数名が応答に混ざっていないことを確認する（内部構成情報の漏洩防止）
      expect(body.error).not.toContain("ANTHROPIC_API_KEY");
      // 設定漏れが運用者に届くよう、サーバログには残っていることを確認する
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      // 後続テストに影響しないよう差し替えとスパイを必ず戻す
      getClientOverride = null;
      errorSpy.mockRestore();
    }
  });

  it("上流 Anthropic の 429 は Retry-After 付きの 429 を返す", async () => {
    // 上流でだけ 429 になるモックを仕込む
    rejectOnceWithApiError(429, "rate_limit_error");
    // 正常な形のリクエストを送る（上流のレート制限に当たった想定）
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 429 が返ることを確認する
    expect(res.status).toBe(429);
    // 再試行の待機秒数を伝える Retry-After が付いていることを確認する
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("ストリーム反復中のエラーはレスポンスボディのエラーとして伝わる", async () => {
    // 最初のデルタを流した後、反復の途中で失敗するストリームを仕込む
    createMock.mockImplementationOnce(() =>
      Promise.resolve(makeFailingStream(new Error("upstream connection lost")))
    );
    // サーバログの出力は別の試験で確認するので、ここでは出力を抑えるだけにする
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る（接続確立後にだけ失敗する想定）
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 接続確立後の失敗なので 200（SSE 開始済み）であることを確認する
      expect(res.status).toBe(200);
      // ボディを読み進めると、途中エラーが reader へ伝播（reject）することを確認する
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      // 1 チャンク目（正常デルタ）は読めることを確認する
      const first = await reader.read();
      expect(first.done).toBe(false);
      // 以降の読み取りはエラーで reject されることを確認する（エラーの握り潰し防止）
      await expect(async () => {
        // ストリームの終端（またはエラー）まで読み続ける
        while (!(await reader.read()).done) {
          // 読み取り継続（エラー到達待ち）
        }
      }).rejects.toThrow("upstream connection lost");
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("ストリーム反復中のエラーはサーバログにも残る", async () => {
    // 反復の途中で上流の切断を模したエラーを投げるストリームを仕込む
    const failure = new Error("upstream connection lost");
    createMock.mockImplementationOnce(() => Promise.resolve(makeFailingStream(failure)));
    // サーバログへの記録を検証するためスパイを仕込む
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る（接続確立後にだけ失敗する想定）
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // ボディを読み進めて反復中のエラーを表面化させる（reject するので捕捉する）
      await expect(drainBody(res.body as ReadableStream<Uint8Array>)).rejects.toThrow(
        "upstream connection lost"
      );
      // 200 を返し終えた後の失敗は POST の catch へ戻らないため、ここで記録しないと
      // 上流障害の痕跡がサーバ側に一切残らない（§6 エラーを握り潰さない）
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure);
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("配信中のクライアント切断をサーバ障害としてログに残さない", async () => {
    // 実 SDK と同じ挙動のストリームを仕込む。
    // SDK は反復中の中断を throw せず正常終了する（core/streaming.js の
    // 「abort されたら return する」）。中断エラーを投げるモックでは実依存と
    // 挙動が食い違い、本番で通る経路を検証できない
    createMock.mockImplementationOnce(() => Promise.resolve(makeAbortAwareStream()));
    // サーバ障害ログが呼ばれないことを検証するためスパイを仕込む
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 読み取り口を取得して 1 チャンク目（正常デルタ）まで読む
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      // 配信の途中でクライアントが切断した状況を作る
      await reader.cancel();
      // 切断で上流の反復が終わり、終端フレームの書き込みが失敗するまで待つ
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 日常的に起きる切断でログを埋めない（本当の上流障害が埋もれるのを防ぐ）。
      // 切断後の書き込みは「Invalid state: Controller is already closed」の
      // TypeError になるため、切断の判定を誤ると毎回ここが障害ログになる
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it.each([
    ["max_tokens", "長さの上限"],
    ["model_context_window_exceeded", "文脈長の超過"],
    ["refusal", "生成の拒否"],
  ])("%s で打ち切られた回答を『完全な回答』として終わらせない", async (stopReason) => {
    // 上流が最後まで話し終えずに生成を止めた場合を模す。
    // 打ち切りの理由を列挙して弾く実装だと、列挙し忘れた理由が
    // 黙って「完全な回答」に化ける（上流の理由は増える）
    createMock.mockImplementationOnce(() =>
      Promise.resolve({
        // 中断用コントローラ（この試験では使われない）
        controller: { abort: vi.fn() },
        // デルタを 1 件流したあと、打ち切りの理由を伝えて正常終了する
        async *[Symbol.asyncIterator]() {
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "途中まで" },
          };
          yield {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
          };
        },
      })
    );
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 応答本文を読み取って文字列にする
    const body = await new Response(res.body).text();
    // 受信済みのデルタは届いていることを確認する
    expect(body).toContain("途中まで");
    // 完了の番兵は送らない（送ると画面側が「完全な回答」として確定させる）
    expect(body).not.toContain(SSE_DONE_MARKER);
  });

  it.each([["end_turn"], ["stop_sequence"]])(
    "%s で終わった回答は完了として扱う",
    async (stopReason) => {
      // 最後まで話し終えた場合を模す
      createMock.mockImplementationOnce(() =>
        Promise.resolve({
          controller: { abort: vi.fn() },
          async *[Symbol.asyncIterator]() {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "完全な回答" },
            };
            yield {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
            };
          },
        })
      );
      // 正常な形のリクエストを送る
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 応答本文を読み取って文字列にする
      const body = await new Response(res.body).text();
      // 完了の番兵が送られることを確認する（付けないと毎回中断扱いになる）
      expect(body).toContain(SSE_DONE_MARKER);
    }
  );

  it("終了理由が 1 度も届かないまま終わった配信を『完全な回答』として終わらせない", async () => {
    // 上流の応答本文が message_delta を出す前に途切れた場合を模す。
    // SDK は本文の途切れを例外にせず反復を終えるため、route からは
    // 「終了理由なしの正常終了」として見える。ここを完了扱いにすると、
    // 既知の打ち切り理由（max_tokens 等）は未完了として扱うのに、
    // 理由すら届かなかったいちばん怪しい配信だけが完了に化ける
    createMock.mockImplementationOnce(() =>
      Promise.resolve({
        // 中断用コントローラ（この試験では使われない）
        controller: { abort: vi.fn() },
        // デルタを 1 件流したところで終了理由を伝えないまま反復を終える
        async *[Symbol.asyncIterator]() {
          // 途中までのデルタを返す
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "途中まで" },
          };
          // message_delta を送らずにストリームが終わる（本文の途切れ）
        },
      })
    );
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 通信としては正常なので 200 のまま（エラーにすると届いている回答に障害の警告が出る）
    expect(res.status).toBe(200);
    // 応答本文を読み取って文字列にする
    const body = await new Response(res.body).text();
    // 受信済みのデルタは届いていることを確認する
    expect(body).toContain("途中まで");
    // 完了の番兵は送らない。送ると画面側が「完全な回答」として確定させ、
    // 次のターンで欠けた回答が文脈として送り返される
    expect(body).not.toContain(SSE_DONE_MARKER);
  });

  it("完了前に中断された配信を『完全な回答』として終わらせない", async () => {
    // プラットフォームの実行時間上限やゲートウェイのタイムアウトで
    // request.signal が中断される状況を作る
    const aborter = new AbortController();
    createMock.mockImplementationOnce(() =>
      Promise.resolve({
        // 中断用コントローラ（この試験では使われない）
        controller: { abort: vi.fn() },
        // 1 件流したところで中断され、SDK と同じく throw せず終了する反復子
        async *[Symbol.asyncIterator]() {
          // 途中までのデルタを 1 件返す
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "途中まで" },
          };
          // ここでリクエストが中断される（プラットフォーム側の打ち切り）
          aborter.abort();
          // 実 SDK は中断でも throw せずに反復を終える
        },
      })
    );
    // 通常のタブ閉じでも request.signal は中断されるため、この経路では
    // サーバ障害ログを出さない（出すと通常の離脱のたびにログが積まれる）
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 中断シグナル付きのリクエストを送る
      const res = await POST(
        makeRequest({ messages: validMessages }, uniqueIp(), "application/json", aborter.signal)
      );
      // ループが例外なく終わっても「完了」とは限らないため、
      // 正常完了（[DONE] を送って close）で終わらせてはいけない。
      // 完了扱いにすると、途中で切れた回答が確定版として履歴に残る
      await expect(drainBody(res.body as ReadableStream<Uint8Array>)).rejects.toThrow();
      // 中断の理由（離脱かプラットフォームの打ち切りか）は区別できないので記録しない
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("切断後に上流がまだデルタを流してきてもサーバ障害としてログに残さない", async () => {
    // 切断に上流がすぐ気づかず、デルタが続けて届く状況を作る。
    // 切断済みの controller へ書きに行くと TypeError になるため、
    // 書き込みの前に切断を確認していないとここで障害ログが出る
    createMock.mockImplementationOnce(() =>
      Promise.resolve(makeAbortAwareStream({ deltasAfterAbort: 3 }))
    );
    // サーバ障害ログが呼ばれないことを検証するためスパイを仕込む
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 読み取り口を取得して 1 チャンク目まで読む
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      // 配信の途中でクライアントが切断した状況を作る
      await reader.cancel();
      // 切断後のデルタが処理されるまで待つ
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 切断後の書き込みを試みていなければ障害ログは出ない
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("クライアント切断と同時に上流が失敗しても、上流の失敗はログに残る", async () => {
    // 切断されたあとに上流側の障害が表面化する状況を作る。
    // ネットワーク障害では上流の切断とブラウザの切断が同時に起きうるため、
    // 切断の有無を先に見て早期 return すると、この競合でだけ本物の障害が消える
    const failure = new Error("upstream connection lost");
    createMock.mockImplementationOnce(() =>
      Promise.resolve(makeAbortAwareStream({ failWhenAborted: failure }))
    );
    // サーバログへの記録を検証するためスパイを仕込む
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 読み取り口を取得して 1 チャンク目まで読む
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      // クライアント切断と同時に上流も落ちた状況にする
      await reader.cancel();
      // 上流の失敗が表面化するまで待つ
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 切断と競合しても上流障害の記録は残る（いちばんログが欲しい場面なので）
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure);
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("中断エラーが反復中に投げられたら、記録はせずクライアントには中断を伝える（分類の保険）", async () => {
    // 実 SDK は反復中に中断を投げないが、SDK の分類が変わった場合に備えた保険の経路。
    // 受信側は切断していないので、cancelledByConsumer ではなく isAbortError で分類される
    createMock.mockImplementationOnce(() =>
      Promise.resolve(makeFailingStream(new Anthropic.APIUserAbortError()))
    );
    // サーバ障害ログが呼ばれないことを検証するためスパイを仕込む
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 回答は途中で切れているので、正常完了として終わらせてはいけない。
      // [DONE] なしで静かに close() すると、読み手は完全な回答として確定させてしまう
      await expect(drainBody(res.body as ReadableStream<Uint8Array>)).rejects.toThrow();
      // 一方これはサーバの障害ではないので、ログには残さない
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("上流 429 の Retry-After を尊重して中継する", async () => {
    // 上流が「300 秒待て」と指定した 429 を返す場合を模す
    createMock.mockImplementationOnce(() =>
      Promise.reject(
        new Anthropic.APIError(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          "rate limited",
          new Headers({ "retry-after": "300" })
        )
      )
    );
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 429 が返ることを確認する
    expect(res.status).toBe(429);
    // 自前の待機時間（60 秒）ではなく上流の指定を伝えることを確認する。
    // 自前の値を返すと、クライアントは成功しえない再試行を繰り返して
    // 自前のレート制限の枠まで食い潰す
    expect(res.headers.get("Retry-After")).toBe("300");
  });

  it("上流 429 の Retry-After が 0 でも最低 1 秒は待たせる", async () => {
    // 0 をそのまま伝えると「すぐ再試行してよい」の意味になり、
    // 上流に弾かれ続けるリクエストで自前の枠まで食い潰す
    createMock.mockImplementationOnce(() =>
      Promise.reject(
        new Anthropic.APIError(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          "rate limited",
          new Headers({ "retry-after": "0" })
        )
      )
    );
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 最低 1 秒は待たせることを確認する
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  // RFC 9110 の delay-seconds は 10 進数字だけなのに、Number() の変換規則に任せると
  // "0x10" が 16 に、"1e3" が 1000 に、"5.9" が（切り上げで）6 に、"+5" が 5 になり、
  // 上流が意図していない待機時間をクライアントへ伝えてしまう。
  // ここに並べるのは「厳密判定を外すと通ってしまう」値だけにする
  // （たとえば HTTP-date 形式や空白だけの値は Number() でも NaN・空文字になるため、
  //   並べても判定の有無を区別できない＝空振りのケースになる）
  it.each([
    ["0x10", "16 進数に見える値"],
    ["1e3", "指数表記の値"],
    ["5.9", "小数の値"],
    ["+5", "符号付きの値"],
    ["10000000000000000000000000", "桁が多すぎる値"],
  ])("秒数として解釈できない Retry-After（%s）は自前の待機時間へ倒す", async (rawHeader) => {
    createMock.mockImplementationOnce(() =>
      Promise.reject(
        new Anthropic.APIError(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          "rate limited",
          new Headers({ "retry-after": rawHeader })
        )
      )
    );
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 上流の値ではなく自前の待機時間（60 秒）が使われることを確認する
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("上流 429 に Retry-After が無ければ自前の待機時間を使う", async () => {
    // ヘッダが無い 429 を返す場合を模す
    createMock.mockImplementationOnce(() =>
      Promise.reject(
        new Anthropic.APIError(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          "rate limited",
          new Headers()
        )
      )
    );
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // 自前のウィンドウ幅（60 秒）へ倒れることを確認する
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("接続確立前のクライアント切断（abort）は 500 ではなく 499 で静かに終える", async () => {
    // 接続前の切断を模して、SDK の中断エラーで reject する実装を 1 回だけ設定する
    createMock.mockImplementationOnce(() =>
      Promise.reject(new Anthropic.APIUserAbortError())
    );
    // サーバ障害ログ（console.error）が呼ばれないことを検証するためスパイを仕込む
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 正常な形のリクエストを送る（接続前に切断された想定）
      const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
      // 通常の切断はサーバエラー（500）ではなく 499 で打ち切られることを確認する
      expect(res.status).toBe(499);
      // 異常系ではないのでサーバ障害ログが残らないことを確認する
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
    }
  });

  it("クライアント切断（ボディの cancel）で上流ストリームも中断される", async () => {
    // 中断呼び出しを検証するため、この試験専用のモックストリームを用意する
    const stream = makeMockStream();
    // このモックストリームで解決する実装を 1 回だけ設定する
    createMock.mockImplementationOnce(() => Promise.resolve(stream));
    // 正常な形のリクエストを送る
    const res = await POST(makeRequest({ messages: validMessages }, uniqueIp()));
    // SSE ストリームが開始されることを確認する
    expect(res.status).toBe(200);
    // クライアント切断を模してレスポンスボディをキャンセルする
    await (res.body as ReadableStream<Uint8Array>).cancel();
    // 上流ストリームの中断（トークン浪費の防止）が呼ばれたことを確認する
    expect(stream.controller.abort).toHaveBeenCalled();
  });
});
