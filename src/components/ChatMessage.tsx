/**
 * チャットメッセージコンポーネント
 * 1つのメッセージ（ユーザーまたはAI）を吹き出し形式で表示する。
 */
"use client";

import type { Message } from "@/lib/types";

/** ChatMessage コンポーネントの Props */
interface ChatMessageProps {
  /** 表示するメッセージオブジェクト */
  message: Message;
}

/**
 * 個別のチャットメッセージを表示するコンポーネント
 * ユーザーのメッセージは右寄せ・青色、AI のメッセージは左寄せ・灰色で表示する。
 */
export default function ChatMessage({ message }: ChatMessageProps) {
  // メッセージの送信者がユーザーかどうかを判定する
  const isUser = message.role === "user";

  return (
    // メッセージ行全体のコンテナ（ユーザーは右寄せ、AI は左寄せ）
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? // ユーザーメッセージ: 青い背景に白文字
              "bg-blue-600 text-white"
            : // AI メッセージ: 灰色の背景に黒文字
              "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
        }`}
      >
        {/* 送信者ラベルを表示する。
            文字色は WCAG AA（通常文 4.5:1）を満たす組み合わせだけを使う（§7）。
            text-xs は「大きな文字」(18pt/14pt太字) に当たらないため 3:1 では不足する。
            - あなた: blue-50 on blue-600 = 4.82:1（旧 blue-100 は 4.31:1 で不足）
            - AI light: gray-600 on gray-100 = 6.87:1（旧 gray-500 は 4.39:1 で不足）
            - AI dark : gray-400 on gray-800 = 5.64:1（据え置き） */}
        <p
          className={`text-xs font-semibold mb-1 ${
            isUser
              ? "text-blue-50"
              : "text-gray-600 dark:text-gray-400"
          }`}
        >
          {isUser ? "あなた" : "AI アシスタント"}
        </p>
        {/* メッセージ本文を表示する（改行を維持） */}
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {message.content}
        </p>
      </div>
    </div>
  );
}
