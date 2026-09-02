/**
 * チャット入力フォームコンポーネント
 * テキスト入力欄と送信ボタンを提供する。
 */
"use client";

import { useState } from "react";
// サーバーが受け付ける 1 メッセージの最大文字数（定義元は @/lib/chat-limits）
import { MAX_CONTENT_LENGTH } from "@/lib/chat-limits";

/** ChatInput コンポーネントの Props */
interface ChatInputProps {
  /** メッセージ送信時に呼ばれるコールバック関数 */
  onSend: (message: string) => void;
  /** 送信中かどうか（true の間は送信ボタンを無効化する） */
  isLoading: boolean;
}

/**
 * チャットの入力フォームを表示するコンポーネント
 * Enter キーまたは送信ボタンでメッセージを送信する。
 */
export default function ChatInput({ onSend, isLoading }: ChatInputProps) {
  // 入力欄のテキストを管理する state
  const [input, setInput] = useState("");

  /**
   * フォーム送信時のハンドラー
   * 空文字でなければ onSend を呼び、入力欄をクリアする。
   */
  const handleSubmit = (e: React.FormEvent) => {
    // ページ遷移を防ぐ
    e.preventDefault();

    // 入力値の前後の空白を除去する
    const trimmed = input.trim();

    // 空文字なら何もしない
    if (!trimmed) return;

    // 親コンポーネントにメッセージを渡す
    onSend(trimmed);

    // 入力欄を空にする
    setInput("");
  };

  return (
    // フォーム全体のコンテナ
    <form onSubmit={handleSubmit} className="flex gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
      {/* テキスト入力欄。maxLength にサーバーと同じ受付上限を指定し、
          確実に 400 になる長さの本文を送ってから初めてエラーが分かる状態を防ぐ */}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="メッセージを入力..."
        aria-label="メッセージを入力"
        maxLength={MAX_CONTENT_LENGTH}
        disabled={isLoading}
        className="flex-1 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
      />
      {/* 送信ボタン */}
      <button
        type="submit"
        disabled={isLoading || !input.trim()}
        className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {/* ローディング中は「送信中...」を表示する */}
        {isLoading ? "送信中..." : "送信"}
      </button>
    </form>
  );
}
