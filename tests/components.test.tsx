/**
 * コンポーネントのテスト
 * ChatMessage, ChatInput, CategoryChips, ChatContainer コンポーネントの描画と
 * アクセシビリティ（ランドマーク・グループ名・prefers-reduced-motion）を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatMessage from "@/components/ChatMessage";
import ChatInput from "@/components/ChatInput";
import CategoryChips from "@/components/CategoryChips";
import ChatContainer from "@/components/ChatContainer";
// 送信前の検証で使う上限と文言（定義元は @/lib/chat-limits）
import { CONTENT_TOO_LONG_MESSAGE, MAX_CONTENT_LENGTH } from "@/lib/chat-limits";

describe("ChatMessage", () => {
  // ユーザーメッセージが正しく表示されることを確認する
  it("ユーザーメッセージが表示されること", () => {
    render(
      <ChatMessage message={{ role: "user", content: "テストメッセージ" }} />
    );
    // メッセージ本文が画面に存在することを確認する
    expect(screen.getByText("テストメッセージ")).toBeInTheDocument();
    // 送信者ラベルが「あなた」であることを確認する
    expect(screen.getByText("あなた")).toBeInTheDocument();
  });

  // AI メッセージが正しく表示されることを確認する
  it("AI メッセージが表示されること", () => {
    render(
      <ChatMessage message={{ role: "assistant", content: "AI の回答です" }} />
    );
    // メッセージ本文が画面に存在することを確認する
    expect(screen.getByText("AI の回答です")).toBeInTheDocument();
    // 送信者ラベルが「AI アシスタント」であることを確認する
    expect(screen.getByText("AI アシスタント")).toBeInTheDocument();
  });
});

describe("ChatInput", () => {
  // 送信ボタンが表示されることを確認する
  it("送信ボタンが表示されること", () => {
    render(<ChatInput onSend={vi.fn()} onClearError={vi.fn()} isLoading={false} />);
    // 送信ボタンがドキュメント内に存在することを確認する
    expect(screen.getByText("送信")).toBeInTheDocument();
  });

  // ローディング中は「送信中...」と表示されることを確認する
  it("ローディング中は送信中と表示されること", () => {
    render(<ChatInput onSend={vi.fn()} onClearError={vi.fn()} isLoading={true} />);
    // 「送信中...」がドキュメント内に存在することを確認する
    expect(screen.getByText("送信中...")).toBeInTheDocument();
  });

  // テキスト入力後に送信でコールバックが呼ばれることを確認する
  it("テキスト入力後に送信で onSend が呼ばれること", () => {
    // モック関数を作成する
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} onClearError={vi.fn()} isLoading={false} />);

    // テキスト入力欄を取得する
    const input = screen.getByPlaceholderText("メッセージを入力...");
    // テキストを入力する
    fireEvent.change(input, { target: { value: "こんにちは" } });
    // フォームを送信する
    fireEvent.submit(input.closest("form")!);

    // onSend が「こんにちは」で呼ばれたことを確認する
    expect(mockOnSend).toHaveBeenCalledWith("こんにちは");
  });

  // 空文字では送信されないことを確認する
  it("空文字では onSend が呼ばれないこと", () => {
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} onClearError={vi.fn()} isLoading={false} />);

    // フォームをそのまま送信する（入力なし）
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.submit(input.closest("form")!);

    // onSend が呼ばれていないことを確認する
    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it("上限を超える本文は送信せず、理由を表示して入力も残すこと", () => {
    // モック関数を作成する
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} onClearError={vi.fn()} isLoading={false} />);

    // 上限を超える長文を入力する
    const tooLong = "あ".repeat(MAX_CONTENT_LENGTH + 1);
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.change(input, { target: { value: tooLong } });
    // フォームを送信する
    fireEvent.submit(input.closest("form")!);

    // 送信していないことを確認する。送るとサーバーは 400 を返す一方で会話履歴には
    // 残るため、以降のすべての送信が同じ 400 になり会話を続けられなくなる
    expect(mockOnSend).not.toHaveBeenCalled();
    // なぜ送られなかったのかが画面に出ることを確認する（§7 状態はテキストで伝える）
    expect(screen.getByRole("alert")).toHaveTextContent(CONTENT_TOO_LONG_MESSAGE);
    // 入力した文章が消えていないことを確認する（消すと長文を貼った人が文章ごと失う）
    expect(input).toHaveValue(tooLong);
  });

  it("送信を止めたときは前回の送信についての通知を消すこと", () => {
    // 画面上部の通知を消すコールバックを記録するモックを用意する
    const mockClearError = vi.fn();
    render(
      <ChatInput
        onSend={vi.fn()}
        onClearError={mockClearError}
        isLoading={false}
      />
    );

    // 上限を超える長文で送信を止めさせる
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.change(input, {
      target: { value: "あ".repeat(MAX_CONTENT_LENGTH + 1) },
    });
    fireEvent.submit(input.closest("form")!);

    // 前回の送信の通知（429 など）を消していることを確認する。消さないと
    // 画面上部の古い通知と入力欄の下の理由が role="alert" として 2 つ並び、
    // いま行った操作と関係の無い理由まで読み上げられてしまう
    expect(mockClearError).toHaveBeenCalled();
  });

  it("同じ本文で再び弾かれたときも警告を出し直すこと", () => {
    // モック関数を作成する
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} onClearError={vi.fn()} isLoading={false} />);

    // 上限を超える長文を入力して送信する
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.change(input, { target: { value: "あ".repeat(MAX_CONTENT_LENGTH + 1) } });
    fireEvent.submit(input.closest("form")!);
    // 1 回目の警告要素を控えておく
    const firstAlert = screen.getByRole("alert");

    // 何も直さずにもう一度送信する（「反応が無い」と思った人が取る自然な操作）
    fireEvent.submit(input.closest("form")!);

    // 警告要素が作り直されていることを確認する。同じ文言を入れ直すだけだと
    // React が再描画を省くため要素はそのまま残り、スクリーンリーダーには
    // 何も読み上げられない＝2 回目の操作に対する反応がゼロになる
    expect(screen.getByRole("alert")).not.toBe(firstAlert);
  });

  it("入力を直し始めた時点で上限超過の警告が消えること", () => {
    // モック関数を作成する
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} onClearError={vi.fn()} isLoading={false} />);

    // まず上限を超える長文で弾かれる状態を作る
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.change(input, { target: { value: "あ".repeat(MAX_CONTENT_LENGTH + 1) } });
    fireEvent.submit(input.closest("form")!);
    // 警告が出ていることを確認する（前提の確認）
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // 送信せずに短く直す（ユーザーが指摘を受けて修正している最中の状態）
    fireEvent.change(input, { target: { value: "短い質問" } });

    // 妥当な入力に直した時点で警告が消えることを確認する。
    // 残っていると、正しい入力が「不正な入力」として読み上げられ続ける
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // 支援技術向けの不正フラグも下りることを確認する
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("上限を超えた後に短く直せば送信できること", () => {
    // モック関数を作成する
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} onClearError={vi.fn()} isLoading={false} />);

    // まず上限を超える長文で弾かれる状態を作る
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.change(input, { target: { value: "あ".repeat(MAX_CONTENT_LENGTH + 1) } });
    fireEvent.submit(input.closest("form")!);

    // 短い文章に直して送信する
    fireEvent.change(input, { target: { value: "短い質問" } });
    fireEvent.submit(input.closest("form")!);

    // 送信できることを確認する
    expect(mockOnSend).toHaveBeenCalledWith("短い質問");
    // 直したら理由の表示も消えることを確認する（古い警告が残り続けない）
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("CategoryChips", () => {
  // すべてのカテゴリチップが表示されることを確認する
  it("カテゴリチップが表示されること", () => {
    render(
      <CategoryChips selected="general" onSelect={vi.fn()} />
    );
    // 「なんでも」チップが存在することを確認する
    expect(screen.getByText("なんでも")).toBeInTheDocument();
    // 「料理」チップが存在することを確認する
    expect(screen.getByText("料理")).toBeInTheDocument();
    // 「掃除・洗濯」チップが存在することを確認する
    expect(screen.getByText("掃除・洗濯")).toBeInTheDocument();
  });

  // チップクリックで onSelect が呼ばれることを確認する
  it("チップクリックで onSelect が呼ばれること", () => {
    const mockOnSelect = vi.fn();
    render(
      <CategoryChips selected="general" onSelect={mockOnSelect} />
    );

    // 「料理」チップをクリックする
    fireEvent.click(screen.getByText("料理"));

    // onSelect が "cooking" で呼ばれたことを確認する
    expect(mockOnSelect).toHaveBeenCalledWith("cooking");
  });
});

describe("アクセシビリティ", () => {
  // scrollIntoView の呼び出し引数を記録するモック（各テストの前に差し替える）
  let scrollSpy: Mock<(options?: boolean | ScrollIntoViewOptions) => void>;

  // 各テストの前に jsdom 未実装の scrollIntoView を記録用モックへ差し替える
  beforeEach(() => {
    // 呼び出し引数を検証できるようモック関数を用意する
    scrollSpy = vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
    // jsdom の Element には scrollIntoView が無いため、プロトタイプへ直接生やす
    Element.prototype.scrollIntoView = scrollSpy;
  });

  // 各テストの後にグローバルの差し替えを元へ戻し、他のテストへ影響させない
  afterEach(() => {
    // vi.stubGlobal で差し替えた matchMedia を復元する
    vi.unstubAllGlobals();
    // プロトタイプへ生やした scrollIntoView を取り除く
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  /**
   * prefers-reduced-motion の判定結果を固定する matchMedia のスタブを仕込む。
   * jsdom には matchMedia が無いため、テスト側で最小限の実装を差し込む。
   * @param reduce - 「動きを減らす」設定が有効かどうか
   */
  function stubReducedMotion(reduce: boolean): void {
    // window.matchMedia を、渡された設定値をそのまま返すスタブに置き換える
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: reduce }));
  }

  it("カテゴリチップ群に名前付きのグループロールが付く", () => {
    // カテゴリチップを描画する
    render(<CategoryChips selected="general" onSelect={vi.fn()} />);
    // 「質問カテゴリ」という名前のグループとして認識できることを確認する
    expect(
      screen.getByRole("group", { name: "質問カテゴリ" })
    ).toBeInTheDocument();
  });

  it("会話一覧が main ランドマークとして公開される", () => {
    // 動きを減らす設定は無効としてスタブしておく
    stubReducedMotion(false);
    // メッセージ 1 件のコンテナを描画する
    render(
      <ChatContainer
        messages={[{ role: "user", content: "こんにちは" }]}
        streamingText=""
      />
    );
    // スクリーンリーダーが本文へ直接移動できる main ランドマークがあることを確認する
    expect(screen.getByRole("main", { name: "会話" })).toBeInTheDocument();
  });

  it("prefers-reduced-motion が有効なら自動スクロールをアニメーションさせない", () => {
    // 「動きを減らす」設定を有効にする
    stubReducedMotion(true);

    // メッセージ 1 件のコンテナを描画して自動スクロールを発火させる
    render(
      <ChatContainer
        messages={[{ role: "user", content: "こんにちは" }]}
        streamingText=""
      />
    );

    // スムーズスクロールではなく瞬間移動（auto）が選ばれることを確認する
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("prefers-reduced-motion が無効ならスムーズスクロールする", () => {
    // 「動きを減らす」設定を無効にする
    stubReducedMotion(false);

    // メッセージ 1 件のコンテナを描画して自動スクロールを発火させる
    render(
      <ChatContainer
        messages={[{ role: "user", content: "こんにちは" }]}
        streamingText=""
      />
    );

    // 既定ではスムーズスクロールが選ばれることを確認する
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth" });
  });
});
