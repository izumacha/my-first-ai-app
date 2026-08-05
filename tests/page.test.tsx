/**
 * チャット画面（src/app/page.tsx）のテスト
 *
 * page.tsx は「SSE の行バッファリング → 差分の逐次表示 → 会話履歴への確定」という
 * route.ts と並ぶ中核ロジックを持つが、これまでテストが 1 件も無かった（§11 の
 * 「境界値を重視する」観点で最も抜けやすい箇所）。fetch をモックして、
 * チャンク分割・[DONE]・エラー応答・リソース解放の各経路を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Home from "@/app/page";

/** テストで組み立てた ReadableStream の解放（cancel）を記録するためのスパイ置き場 */
let cancelSpy: Mock<() => void>;

/**
 * 与えた文字列チャンクを順に流す ReadableStream を組み立てる。
 * SSE は行境界と無関係な位置で分割されて届くため、テストでも意図的に
 * 「行の途中」で切れたチャンクを渡せるようにしている。
 * @param chunks - 送出するチャンク文字列の配列
 * @returns チャンクを順に流す ReadableStream
 */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  // 文字列をバイト列へ変換するためのエンコーダを用意する
  const encoder = new TextEncoder();
  // チャンクを 1 つずつ enqueue して閉じるストリームを返す
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 各チャンクをバイト列に変換して順に流す
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      // すべて流し終えたらストリームを閉じる
      controller.close();
    },
  });
  // cancel の呼び出しを記録できるよう、getReader が返す reader をラップする
  const originalGetReader = stream.getReader.bind(stream);
  // getReader を差し替えて、返す reader の cancel をスパイ経由にする
  stream.getReader = (() => {
    // 本来の reader を取得する
    const reader = originalGetReader();
    // 本来の cancel を退避しておく
    const originalCancel = reader.cancel.bind(reader);
    // cancel を「記録してから本来の処理へ委譲する」関数に差し替える
    reader.cancel = (reason?: unknown) => {
      // 呼び出しを記録する
      cancelSpy();
      // 本来の cancel を実行して結果をそのまま返す
      return originalCancel(reason);
    };
    // 差し替え済みの reader を返す
    return reader;
  }) as typeof stream.getReader;
  // 組み立てたストリームを返す
  return stream;
}

/**
 * 画面のメッセージ入力欄に文字を入れて送信する。
 * @param text - 送信するメッセージ本文
 */
function sendMessage(text: string): void {
  // ラベルから入力欄を取得する
  const input = screen.getByLabelText("メッセージを入力");
  // 入力欄に本文を入力する
  fireEvent.change(input, { target: { value: text } });
  // 送信ボタンを押してフォームを送信する
  fireEvent.click(screen.getByRole("button", { name: "送信" }));
}

describe("チャット画面のストリーミング処理", () => {
  // 各テストの前に fetch のモックとスパイを初期化する
  beforeEach(() => {
    // cancel 呼び出しの記録用スパイを作り直す
    cancelSpy = vi.fn<() => void>();
    // jsdom には scrollIntoView が無いため、自動スクロールの呼び出しを無害化する
    Element.prototype.scrollIntoView = vi.fn();
  });

  // 各テストの後にモックを元に戻す
  afterEach(() => {
    // グローバルの差し替え（fetch など）をすべて復元する
    vi.restoreAllMocks();
  });

  it("行の途中で分割されたチャンクを結合して回答を組み立てること", async () => {
    // "data: " 行の途中で切れるようにチャンクを分割して流す（行バッファの検証）
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          makeStream([
            'data: {"text":"こん',
            'にちは"}\n\ndata: {"tex',
            't":"、世界"}\n\ndata: [DONE]\n\n',
          ]),
          { status: 200 }
        )
      )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 2 つのチャンクにまたがった差分が欠落せず結合されて表示されることを確認する
    await waitFor(() => {
      expect(screen.getByText("こんにちは、世界")).toBeInTheDocument();
    });
  });

  it("[DONE] 受信後にレスポンスボディを解放すること", async () => {
    // 通常どおり 1 件の差分と [DONE] を流すストリームを返す
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            makeStream(['data: {"text":"回答"}\n\ndata: [DONE]\n\n']),
            { status: 200 }
          )
        )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 回答が確定するまで待つ
    await waitFor(() => {
      expect(screen.getByText("回答")).toBeInTheDocument();
    });
    // [DONE] で読み取りを打ち切った後も reader が解放されることを確認する
    // （解放しないとレスポンスボディがロックされたままコネクションを掴み続ける）
    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalled();
    });
  });

  it("エラー応答ではサーバの日本語メッセージをそのまま表示すること", async () => {
    // 429（レート制限）とサーバの日本語文言を返す応答をモックする
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "リクエスト数が上限を超えました。しばらくお待ちください。",
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // role="alert" の領域にサーバの文言が表示されることを確認する
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "リクエスト数が上限を超えました。"
      );
    });
  });

  it("JSON でないエラー応答では汎用の日本語文言にフォールバックすること", async () => {
    // 逆プロキシが返す HTML のように、JSON として読めない 500 応答をモックする
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>Bad Gateway</html>", { status: 500 })
        )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // JSON パースに失敗しても画面が落ちず、汎用文言が出ることを確認する
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "エラーが発生しました。"
      );
    });
  });

  it("ストリームが途中で切れても受信済みの回答を会話履歴に残すこと", async () => {
    // [DONE] を送らずに途中でエラーになるストリームを組み立てる。
    // start() 内で enqueue 直後に error() を呼ぶと、仕様どおり内部キューが破棄されて
    // 差分が 1 件も届かない。「差分を受け取った後に切断された」状況を再現するため、
    // pull（読み取り要求）ごとに 1 回目は差分を流し、2 回目でエラーにする
    const encoder = new TextEncoder();
    // 何回目の読み取り要求かを数えるカウンタ
    let pullCount = 0;
    const brokenStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 読み取り要求の回数を進める
        pullCount += 1;
        // 1 回目の要求では完結した差分行を 1 件だけ流す
        if (pullCount === 1) {
          controller.enqueue(encoder.encode('data: {"text":"途中まで"}\n\n'));
          return;
        }
        // 2 回目以降は続きを送らず、上流切断を模したエラーで終了させる
        controller.error(new Error("connection lost"));
      },
    });
    // 上記の壊れたストリームを返す応答をモックする
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(brokenStream, { status: 200 }))
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 受信済みのテキストが宙に浮かず、会話履歴の吹き出しとして残ることを確認する
    await waitFor(() => {
      expect(screen.getByText("途中まで")).toBeInTheDocument();
    });
    // 通信エラーの通知も併せて表示されることを確認する
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("通信エラー");
    });
  });
});
