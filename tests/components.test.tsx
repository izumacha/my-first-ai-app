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
    render(<ChatInput onSend={vi.fn()} isLoading={false} />);
    // 送信ボタンがドキュメント内に存在することを確認する
    expect(screen.getByText("送信")).toBeInTheDocument();
  });

  // ローディング中は「送信中...」と表示されることを確認する
  it("ローディング中は送信中と表示されること", () => {
    render(<ChatInput onSend={vi.fn()} isLoading={true} />);
    // 「送信中...」がドキュメント内に存在することを確認する
    expect(screen.getByText("送信中...")).toBeInTheDocument();
  });

  // テキスト入力後に送信でコールバックが呼ばれることを確認する
  it("テキスト入力後に送信で onSend が呼ばれること", () => {
    // モック関数を作成する
    const mockOnSend = vi.fn();
    render(<ChatInput onSend={mockOnSend} isLoading={false} />);

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
    render(<ChatInput onSend={mockOnSend} isLoading={false} />);

    // フォームをそのまま送信する（入力なし）
    const input = screen.getByPlaceholderText("メッセージを入力...");
    fireEvent.submit(input.closest("form")!);

    // onSend が呼ばれていないことを確認する
    expect(mockOnSend).not.toHaveBeenCalled();
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
