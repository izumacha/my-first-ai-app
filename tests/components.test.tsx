/**
 * コンポーネントのテスト
 * ChatMessage, ChatInput, CategoryChips コンポーネントの描画を検証する。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatMessage from "@/components/ChatMessage";
import ChatInput from "@/components/ChatInput";
import CategoryChips from "@/components/CategoryChips";

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
