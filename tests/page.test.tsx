/**
 * チャット画面（src/app/page.tsx）のテスト
 *
 * page.tsx は「SSE の行バッファリング → 差分の逐次表示 → 会話履歴への確定」という
 * route.ts と並ぶ中核ロジックを持つが、これまでテストが 1 件も無かった（§11 の
 * 「境界値を重視する」観点で最も抜けやすい箇所）。fetch をモックして、
 * チャンク分割・[DONE]・エラー応答・リソース解放の各経路を検証する。
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Home from "@/app/page";
// 送信履歴の上限（画面とサーバーで共有する定数）を参照する
import { MAX_CONTENT_LENGTH, MAX_MESSAGE_COUNT } from "@/lib/chat-limits";
import type { Message } from "@/lib/types";

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

/**
 * 送信処理が完全に終わる（isLoading が false に戻る）まで待つ。
 *
 * 表示の検証（例: 回答テキストの出現）だけでテストを終えると、その後も
 * [DONE] の処理・reader の解放・履歴への確定・ローディング解除といった
 * 非同期の状態更新が続き、テスト終了後（afterEach の後）に React の再描画が
 * 走ってしまう。片付け済みのスタブを掴んで落ちる不安定なテストになるため、
 * 各テストは必ずこれで「処理が完全に終わった」ことを待ってから終える。
 *
 * 送信中はボタンの文言が「送信中...」に変わるので、「送信」という名前の
 * ボタンが再び現れたことをもって完了と判定する。
 */
async function waitForIdle(): Promise<void> {
  // ボタンの文言が「送信」に戻る＝ isLoading が false になるまで待つ
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "送信" })).toBeInTheDocument();
  });
}

describe("チャット画面のストリーミング処理", () => {
  // jsdom の Element には scrollIntoView が無いため、プロトタイプへ直接生やして
  // 自動スクロールの呼び出しを無害化する。
  // テストごと（beforeEach/afterEach）ではなくファイル単位で着脱するのが重要:
  // テストの合間に一瞬でも取り外すと、直前のテストの積み残しの再描画がその隙間に
  // 入り込んで「scrollIntoView is not a function」で落ちる不安定なテストになる
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  // ファイル内の全テストが終わってから取り除く（他のテストファイルへ漏らさない）
  afterAll(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  // 各テストの前にスパイを初期化する
  beforeEach(() => {
    // cancel 呼び出しの記録用スパイを作り直す
    cancelSpy = vi.fn<() => void>();
  });

  // 各テストの後に差し替えたものを元に戻す
  afterEach(() => {
    // vi.stubGlobal で差し替えた fetch を復元する。
    // 注意: vi.restoreAllMocks() は spy を戻すだけで stubGlobal は解除しないため、
    // ここは必ず unstubAllGlobals を使う（components.test.tsx の matchMedia と同じ）
    vi.unstubAllGlobals();
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
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
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
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
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
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
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
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
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

    // 例外そのものがコンソールへ残ることも確かめる（握り潰すと、画面には
    // 「通信エラー」としか出ないまま原因を追う手がかりが消える）
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 途切れた配信は debug に落とすので、そちらも観測できるようにする
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // 途中で失敗しても必ずスパイを戻すため try/finally で囲む。
    // 戻し忘れると console.error がモックのまま後続のテストへ漏れ、
    // それらの診断出力が黙って飲み込まれる
    try {
      // チャット画面を描画する
      render(<Home />);
      // メッセージを送信する
      sendMessage("テスト質問");

      // 受信済みのテキストが宙に浮かず、会話履歴の吹き出しとして残ることを確認する。
      // ただし完全な回答と見分けが付くよう、中断された印が付いた状態で残る
      await waitFor(() => {
        expect(screen.getByText(/途中まで/)).toBeInTheDocument();
      });
      // 途切れている印が付くことを確認する。印が無いと画面上は完全な回答と区別が付かず、
      // 次の質問ではこの欠けた回答が文脈として送り返されてしまう
      await waitFor(() => {
        expect(screen.getByText(/途切れています/)).toBeInTheDocument();
      });
      // 「最後まで受け取れなかった」ことを伝える通知が出ることを確認する。
      // ここで「通信エラー…接続を確認してください」と出してはいけない:
      // サーバーは完了前に終わったことを error で伝えるが、その原因は
      // プラットフォームの実行時間上限などで、接続には問題が無いことがある
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "回答を最後まで受け取れませんでした"
        );
      });
      // 途切れた回答を印付きで残せているので、障害としては積み上げない
      // （長い回答では日常的に起こる）。捨てずに debug には残す
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();
      // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
      await waitForIdle();
    } finally {
      // スパイを元に戻して他のテストへ影響させない
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("1 文字も届かずに配信が切れた場合も接続の問題として伝えないこと", async () => {
    // ヘッダは返ったが、最初の差分が届く前にサーバーが「完了前に終わった」ことを
    // error で伝えてくる状況を模す（プラットフォームの実行時間上限など）
    const brokenStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("ストリーミングが完了前に中断されました"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(brokenStream, { status: 200 }))
    );
    // この経路では障害ログを積み上げない（接続は成立している）
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      // チャット画面を描画してメッセージを送信する
      render(<Home />);
      sendMessage("テスト質問");

      // 印付きの回答すら出ないぶん、文言の誤りがいちばん誤解を招く経路。
      // 接続には問題が無いので「接続を確認してください」とは言わない
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "回答を最後まで受け取れませんでした"
        );
      });
      expect(errorSpy).not.toHaveBeenCalled();
      // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
      await waitForIdle();
    } finally {
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("CRLF で区切られたストリームでも完全な回答として扱うこと", async () => {
    // 途中のプロキシが CRLF で流す場合を模す。行末の CR を落とし損ねると
    // 本文は届くのに [DONE] だけ一致せず、完全な回答に中断の印が付いてしまう
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            makeStream(['data: {"text":"完全な回答"}\r\n\r\ndata: [DONE]\r\n\r\n']),
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
      expect(screen.getByText("完全な回答")).toBeInTheDocument();
    });
    // 途切れている印が付いていないことを確認する
    expect(screen.queryByText(/途切れています/)).not.toBeInTheDocument();
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
  });

  it("解析できない差分があった回答には途切れている印を付けること", async () => {
    // 壊れた差分が 1 件混じるが [DONE] は普通に届く場合を模す。
    // 読み飛ばした事実を覚えていないと、欠けのある回答が完全な回答として確定する
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          makeStream([
            'data: {"text":"前半"}\n\ndata: {壊れた\n\ndata: [DONE]\n\n',
          ]),
          { status: 200 }
        )
      )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 受け取れた分が表示されることを確認する
    await waitFor(() => {
      expect(screen.getByText(/前半/)).toBeInTheDocument();
    });
    // 欠けがあるので途切れている印が付くことを確認する
    await waitFor(() => {
      expect(screen.getByText(/途切れています/)).toBeInTheDocument();
    });
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
  });

  it("形は正しいが中身が想定外の差分も『欠け』として扱うこと", async () => {
    // JSON としては解析できるが text が文字列でない差分を混ぜる。
    // 型を確かめずに足すと "undefined" が本文へ紛れ込み、しかも解析は
    // 成功しているので完全な回答として確定してしまう
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          makeStream([
            'data: {"text":"前半"}\n\ndata: {"txt":"あ"}\n\ndata: [DONE]\n\n',
          ]),
          { status: 200 }
        )
      )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 欠けがあるので途切れている印が付くことを確認する
    await waitFor(() => {
      expect(screen.getByText(/途切れています/)).toBeInTheDocument();
    });
    // "undefined" が本文へ紛れ込んでいないことを確認する
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
  });

  it("CR だけで区切られたストリームでも回答を組み立てること", async () => {
    // 行区切りが CR だけの場合を模す。LF だけで割る実装だと 1 行も切り出せず、
    // 応答全体がバッファに溜まったまま捨てられて回答が丸ごと消える
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            makeStream(['data: {"text":"CR 区切りの回答"}\r\rdata: [DONE]\r\r']),
            { status: 200 }
          )
        )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 回答が組み立てられることを確認する
    await waitFor(() => {
      expect(screen.getByText("CR 区切りの回答")).toBeInTheDocument();
    });
    // 完了も検出できているので途切れている印は付かない
    expect(screen.queryByText(/途切れています/)).not.toBeInTheDocument();
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
  });

  it("回答を 1 文字も受け取れなかったときは理由を表示すること", async () => {
    // 上流が本文を返さずに正常終了した場合を模す（長さ上限に本文なしで達した等）
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(makeStream(["data: [DONE]\n\n"]), { status: 200 })
        )
    );

    // チャット画面を描画する
    render(<Home />);
    // メッセージを送信する
    sendMessage("テスト質問");

    // 何も起きなかったように終わらせず、理由が表示されることを確認する。
    // 黙って終わると、ユーザーは失敗に気づかず再送して上流の呼び出しを重ねる
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("回答を受け取れませんでした");
    });
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
  });

  it("最後まで届いた回答には途切れている印を付けないこと", async () => {
    // 差分と [DONE] を正常に流すストリームを返す
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            makeStream(['data: {"text":"完全な回答"}\n\ndata: [DONE]\n\n']),
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
      expect(screen.getByText("完全な回答")).toBeInTheDocument();
    });
    // 正常に完了した回答に途切れている印が付いていないことを確認する
    // （付いてしまうと、毎回の回答に誤った注意書きが残る）
    expect(screen.queryByText(/途切れています/)).not.toBeInTheDocument();
    // 積み残しの再描画をテスト外へ持ち越さないよう、処理完了まで待ってから終える
    await waitForIdle();
  });

  it("上限を超える本文は送信も履歴への追加もしないこと（画面全体の契約）", async () => {
    // fetch が呼ばれないことを確かめるためモックを差し替える
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // チャット画面を描画する
    render(<Home />);
    // 上限を超える長文を送信する。
    // 止めているのは入力欄側の検証だが、ここで確かめたいのは層ではなく
    // 「画面から長すぎる本文を送っても、リクエストも履歴も汚れない」という結果
    sendMessage("あ".repeat(MAX_CONTENT_LENGTH + 1));

    // 送信していないことを確認する（サーバーの 400 を待たずに止める）
    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalled();
    });
    // 履歴にも積まれていないことを確認する。積むと以降のすべての送信が
    // 同じ 400 になり、往復が成立しないので窓からも抜けず復帰できなくなる
    expect(screen.queryByText(/^あ+$/)).not.toBeInTheDocument();
  });

  it("会話が続いても送信する履歴を受付上限以内に保つこと", async () => {
    // 送信されたリクエストボディを順に記録する配列
    const sentBodies: { messages: Message[] }[] = [];
    // 呼び出しのたびに新しいストリームを返す（Response のボディは 1 度しか読めないため）
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        // 送信されたボディを解析して記録する
        sentBodies.push(JSON.parse(init.body as string));
        // 1 件の差分と [DONE] を流す応答を返す
        return Promise.resolve(
          new Response(makeStream(['data: {"text":"回答"}\n\ndata: [DONE]\n\n']), {
            status: 200,
          })
        );
      })
    );

    // チャット画面を描画する
    render(<Home />);

    // 1 往復ごとに履歴が 2 件（user + assistant）増えるので、上限を必ず超える回数だけ往復する。
    // 切り詰めが無いと、この回数に達した時点でサーバーが 400 を返し以降ずっと送信できなくなる
    const exchanges = Math.ceil(MAX_MESSAGE_COUNT / 2) + 1;
    for (let i = 0; i < exchanges; i += 1) {
      // メッセージを送信する
      sendMessage(`質問${i}`);
      // 次の送信ができる状態に戻るまで待つ
      await waitForIdle();
    }

    // 上限を超える履歴が積まれた後の送信であることを確認する（テスト自体が前提を満たすかの確認）
    expect(sentBodies.length).toBe(exchanges);
    // どの送信でも、サーバーが受け付ける件数を超えていないことを確認する
    for (const body of sentBodies) {
      expect(body.messages.length).toBeLessThanOrEqual(MAX_MESSAGE_COUNT);
      // 上流 Claude API は最初のメッセージが user ロールであることを要求する
      expect(body.messages[0].role).toBe("user");
    }
    // 最後の送信には、いま入力した最新の質問が含まれることを確認する（古い側だけが捨てられる）
    const lastMessages = sentBodies[sentBodies.length - 1].messages;
    expect(lastMessages[lastMessages.length - 1].content).toBe(
      `質問${exchanges - 1}`
    );
  });
});
