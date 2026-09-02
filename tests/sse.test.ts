/**
 * SSE フレーム書式（`src/lib/sse.ts`）のテスト
 *
 * 単体の整形・解析に加えて、**サーバーが実際に流したバイト列をクライアントと同じ手順で
 * 読み直す**契約テストを置く。送信側と受信側は別ファイルにあり、片方だけ書式を変えても
 * 型チェックは通ってしまうため、両者が同じ約束事に従っていることをここで機械的に守る。
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  formatSseFrame,
  parseSseDataLine,
  readSseAnswer,
  splitSseLines,
  SSE_DATA_PREFIX,
  SSE_DONE_MARKER,
} from "@/lib/sse";

/** 契約テストで上流 Claude が返したことにするテキスト差分の並び */
const UPSTREAM_DELTAS = ["こんにちは", "。今日は", "いい天気ですね"];

// 上流ストリームのモックを作る（実 SDK の Stream と同じく中断用 controller を持たせる）
function makeMockStream() {
  return {
    // クライアント切断時に route が呼ぶ中断用コントローラ
    controller: { abort: vi.fn() },
    // テキスト差分イベントを順に流す非同期イテレータ
    async *[Symbol.asyncIterator]() {
      // 差分を 1 件ずつ content_block_delta イベントとして返す
      for (const text of UPSTREAM_DELTAS) {
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
      // 最後まで話し終えたことを伝えるイベントを返す（実ストリームは必ず終了理由を
      // 伝えて終わる。省くと「本文が途中で途切れたストリーム」を模すことになり、
      // サーバーは完了の番兵を送らない＝正常系の契約テストにならない）
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      };
    },
  };
}

// Anthropic クライアントをモックする（実 API を呼ばない）
vi.mock("@/lib/anthropic", async (importOriginal) => {
  // 実モジュールからエラークラスなどを引き継ぐ
  const actual = await importOriginal<typeof import("@/lib/anthropic")>();
  return {
    ...actual,
    // モデル名はテスト用の固定値にする
    MODEL_NAME: "test-model",
    // 既定の max_tokens もテスト用の固定値にする
    DEFAULT_MAX_TOKENS: 1024,
    // クライアント取得はモックストリームで解決する偽クライアントを返す
    getAnthropicClient: () => ({
      messages: { create: () => Promise.resolve(makeMockStream()) },
    }),
  };
});

// テスト対象の POST ハンドラーをモック定義の後で読み込む
import { POST } from "@/app/api/chat/route";

describe("formatSseFrame", () => {
  it("プレフィックスを付け、イベント終端の空行で閉じる", () => {
    // 本文を渡してフレームへ整形する
    expect(formatSseFrame("abc")).toBe(`${SSE_DATA_PREFIX}abc\n\n`);
  });

  it("空の本文でもフレームの形は崩れない", () => {
    // 境界値として空文字列を渡す
    expect(formatSseFrame("")).toBe(`${SSE_DATA_PREFIX}\n\n`);
  });
});

describe("parseSseDataLine", () => {
  it("データ行から本文だけを取り出す", () => {
    // プレフィックス付きの行から本文が取り出せることを確認する
    expect(parseSseDataLine(`${SSE_DATA_PREFIX}abc`)).toBe("abc");
  });

  it("フレーム区切りの空行は本文なし（null）として扱う", () => {
    // 空行はデータ行ではないので null になることを確認する
    expect(parseSseDataLine("")).toBeNull();
  });

  it("データ行でない行は本文なし（null）として扱う", () => {
    // event 行のような別種の行が誤って本文として扱われないことを確認する
    expect(parseSseDataLine("event: ping")).toBeNull();
  });

  it("本文に区切り文字と同じ並びが含まれても切り詰めない", () => {
    // 本文側に "data: " が現れても、先頭の 1 回だけを取り除くことを確認する
    expect(parseSseDataLine(`${SSE_DATA_PREFIX}${SSE_DATA_PREFIX}x`)).toBe(
      `${SSE_DATA_PREFIX}x`
    );
  });

  it("整形した結果の 1 行目は必ず解析できる（整形と解析が対になっている）", () => {
    // 整形 → 改行で分割 → 解析、と往復させて元の本文に戻ることを確認する
    const [firstLine] = formatSseFrame("往復").split("\n");
    expect(parseSseDataLine(firstLine)).toBe("往復");
  });
});

describe("SSE のサーバー↔クライアント契約", () => {
  it("API が実際に流したバイト列を、画面と同じ手順で読み直すと元のテキストに戻る", async () => {
    // 正常なリクエストを送って SSE レスポンスを受け取る
    const request = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.10",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "やあ" }] }),
    });
    const response = await POST(request);
    // SSE として返っていることを確認する
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // レスポンスボディを最後まで読み取って 1 本の文字列にする
    const reader = response.body!.getReader();
    // バイト列を文字列へ復号するデコーダーを用意する
    const decoder = new TextDecoder();
    // 受信した本文を貯める変数
    let wire = "";
    // ストリームの終わりまで読み続ける
    for (;;) {
      // 次のかたまりを読み取る
      const { done, value } = await reader.read();
      // 読み終わったらループを抜ける
      if (done) break;
      // かたまりを復号して連結する
      wire += decoder.decode(value, { stream: true });
    }

    // ここから先は src/app/page.tsx の読み取りループと同じ手順で解析する
    // 受信テキストを行に分割する
    const lines = wire.split("\n");
    // 復元したテキストを貯める変数
    let restored = "";
    // 終了マーカーを受け取ったかどうか
    let sawDone = false;
    // 各行をデータ行として解析する
    for (const line of lines) {
      // データ行なら本文を取り出す（データ行でなければ null）
      const data = parseSseDataLine(line);
      // データ行でない行は読み飛ばす
      if (data === null) continue;
      // 終了マーカーなら解析を終える
      if (data === SSE_DONE_MARKER) {
        sawDone = true;
        break;
      }
      // 本文を JSON として解析してテキスト差分を取り出す
      restored += (JSON.parse(data) as { text: string }).text;
    }

    // 上流が流した差分が欠けも重複もなく復元できることを確認する
    expect(restored).toBe(UPSTREAM_DELTAS.join(""));
    // 終了マーカーが最後に流れていることを確認する（受信側はこれで読み取りを終える）
    expect(sawDone).toBe(true);
  });
});

describe("splitSseLines", () => {
  it("LF で区切られた行を切り出し、未完の行を持ち越す", () => {
    // 最後の要素は行の途中の可能性があるので持ち越す
    expect(splitSseLines("a\nb\nc")).toEqual({ lines: ["a", "b"], remainder: "c" });
  });

  it("CRLF で区切られた行から CR を残さない", () => {
    // CR が残ると本文の末尾に付き、終端の番兵と文字列比較したときに一致しない。
    // JSON としては CR は空白なので解析は通ってしまい、「本文は届くのに完了だけ
    // 検出できない」＝完全な回答が毎回「中断された」と誤判定される
    expect(splitSseLines("a\r\nb\r\n").lines).toEqual(["a", "b"]);
  });

  it("CR だけで区切られた行も切り出す", () => {
    // LF だけで割ると 1 行も切り出せず、応答全体がバッファに溜まったまま捨てられる
    expect(splitSseLines("a\rb\rc")).toEqual({ lines: ["a", "b"], remainder: "c" });
  });

  it("区切りが 1 つも無ければ全体を持ち越す", () => {
    // 行の途中で読み取りが区切られた場合に、次の受信と連結できるようにする
    expect(splitSseLines("data: {\"te")).toEqual({
      lines: [],
      remainder: 'data: {"te',
    });
  });

  it("切り出した行はそのままデータ行として解析できる", () => {
    // 行区切りの処理と data 行の解析が噛み合っていることを確かめる
    const { lines } = splitSseLines(
      `${SSE_DATA_PREFIX}${SSE_DONE_MARKER}\r\n\r\n`
    );
    expect(parseSseDataLine(lines[0])).toBe(SSE_DONE_MARKER);
  });
});

describe("readSseAnswer", () => {
  /**
   * 指定したバイト列を順に流す読み取り口を作る。
   * @param chunks - 流すバイト列（読み終えたら done になる）
   * @returns readSseAnswer に渡せる読み取り口
   */
  function readerOf(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
    // 与えられたかたまりを順に流すストリームを組み立てる
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }).getReader();
  }

  it("呼び出し元のコールバックが投げた例外はそのまま伝わる", async () => {
    // 差分 1 件と終端の番兵を流す（本来なら完了として扱われる配信）
    const encoder = new TextEncoder();
    const reader = readerOf([
      encoder.encode(formatSseFrame(JSON.stringify({ text: "こんにちは" }))),
      encoder.encode(formatSseFrame(SSE_DONE_MARKER)),
    ]);
    // 表示側の不具合を模して、コールバックで例外を投げる
    const boom = new Error("表示側の不具合");
    // 例外が握り潰されず呼び出し元へ届くことを確認する。
    // 中で握り潰すと「壊れた差分」として分類され、完全な回答が
    // 「途切れています」の印付きで確定してしまう
    await expect(
      readSseAnswer(reader, () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  it("行区切りが来ないまま伸び続ける受信は頭打ちにして未完了として扱う", async () => {
    // 応答を 1 本の終端されない行にまとめるプロキシを模す。
    // 頭打ちが無いと、画面には何も出ないままタブが応答全体を抱え込む
    const encoder = new TextEncoder();
    const huge = "x".repeat(600_000);
    // 終端されない巨大な行のあとに、正常な終端の番兵が届く配信にする。
    // 頭打ちが無いと巨大な行はバッファに溜まったまま番兵だけが解析され、
    // 「何も捨てていない完全な回答」として確定してしまう
    const reader = readerOf([
      encoder.encode(huge),
      encoder.encode(huge),
      encoder.encode(`\n\n${formatSseFrame(SSE_DONE_MARKER)}`),
    ]);
    // 読み取りを実行する
    const answer = await readSseAnswer(reader, () => {});
    // 捨てた分があるので、番兵を受け取っていても完了として扱わない
    expect(answer.completed).toBe(false);
  });

  it("終端の番兵が来ないまま終わった配信は未完了として扱う", async () => {
    // 差分だけを流して番兵を送らずに終わる（多バイト文字の途中で切れた場合も
    // ここに含まれる。デコーダーに残ったバイト列があっても判定は変わらない）
    const encoder = new TextEncoder();
    const reader = readerOf([
      encoder.encode(formatSseFrame(JSON.stringify({ text: "途中まで" }))),
      encoder.encode("あ").slice(0, 2),
    ]);
    // 読み取りを実行する
    const answer = await readSseAnswer(reader, () => {});
    // 番兵を受け取っていないので完了として扱わない（画面は印を付けて履歴に残す）
    expect(answer.completed).toBe(false);
  });
});
