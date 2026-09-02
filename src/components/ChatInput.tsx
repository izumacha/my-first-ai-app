/**
 * チャット入力フォームコンポーネント
 * テキスト入力欄と送信ボタンを提供する。
 */
"use client";

import { useState } from "react";
// 本文の受付上限とその超過を知らせる文言（定義元は @/lib/chat-limits）
import { CONTENT_TOO_LONG_MESSAGE, MAX_CONTENT_LENGTH } from "@/lib/chat-limits";

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
  // 送信前の検証で弾いた理由を保持する state（問題が無ければ null）
  const [inputError, setInputError] = useState<string | null>(null);

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

    // 上限を超える本文は送らずにここで止める。
    // 送ってしまうと、サーバーが 400 を返す一方で会話履歴には残るため、
    // 以降のすべての送信が同じ 400 になり、再読み込みするまで会話を続けられなくなる。
    // 入力はあえて消さない（消すと、長文を貼り付けた人がその文章ごと失う）
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      setInputError(CONTENT_TOO_LONG_MESSAGE);
      return;
    }

    // 検証を通ったので、前回の理由表示があれば消す
    setInputError(null);

    // 親コンポーネントにメッセージを渡す
    onSend(trimmed);

    // 入力欄を空にする
    setInput("");
  };

  return (
    // フォーム全体のコンテナ
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
      {/* 入力欄と送信ボタンを横に並べる行 */}
      <div className="flex gap-2">
        {/* テキスト入力欄。
            maxLength は意図的に付けない: 上限を超えた入力を無言で削ると、ユーザーは
            質問が途中で切れたことに気づけないまま送信してしまう。代わりに送信時に
            長さを検証し、理由を下に表示して入力はそのまま残す（§7 状態はテキストで伝える） */}
        <input
          type="text"
          value={input}
          onChange={(e) => {
            // 入力を反映する
            setInput(e.target.value);
            // 直し始めたら前回の理由表示を消す。消さないと、短く直したあとも
            // 「上限を超えています」と aria-invalid が残り続け、妥当な入力が
            // 支援技術に不正な入力として読み上げられてしまう（再検証は送信時に行う）
            if (inputError) {
              setInputError(null);
            }
          }}
          placeholder="メッセージを入力..."
          aria-label="メッセージを入力"
          // 上限超過で弾かれている間は、支援技術にも「不正な入力」であることを伝える
          aria-invalid={inputError !== null}
          // 理由の文章と入力欄を結び付け、読み上げでも対応が分かるようにする
          aria-describedby={inputError ? "chat-input-error" : undefined}
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
      </div>
      {/* 送信前の検証で弾いた理由を表示する（role="alert" で即時に読み上げさせる） */}
      {inputError && (
        <p id="chat-input-error" role="alert" className="text-sm text-red-700 dark:text-red-300">
          {inputError}
        </p>
      )}
    </form>
  );
}
