/**
 * チャットコンテナコンポーネント
 * メッセージ一覧を表示し、新しいメッセージが追加されたら自動スクロールする。
 */
"use client";

import { useRef, useEffect } from "react";
import ChatMessage from "./ChatMessage";
import type { Message } from "@/lib/types";

/** ChatContainer コンポーネントの Props */
interface ChatContainerProps {
  /** 表示するメッセージの配列 */
  messages: Message[];
  /** AI がストリーミング中のテキスト（空文字なら非表示） */
  streamingText: string;
}

/**
 * メッセージ一覧を表示し、自動スクロール機能を持つコンテナ
 * 新しいメッセージが追加されるたびにスクロール位置を最下部に移動する。
 */
export default function ChatContainer({
  messages,
  streamingText,
}: ChatContainerProps) {
  // スクロール位置の基準となるダミー要素の参照
  const bottomRef = useRef<HTMLDivElement>(null);

  // メッセージまたはストリーミングテキストが変わったら最下部にスクロールする
  useEffect(() => {
    // ダミー要素が画面内に入るようスムーズにスクロールする
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  return (
    // メッセージ一覧のスクロール可能なコンテナ
    <div className="flex-1 overflow-y-auto p-4">
      {/* メッセージが空の場合はウェルカムメッセージを表示する */}
      {messages.length === 0 && !streamingText && (
        <div className="flex h-full items-center justify-center">
          <div className="text-center text-gray-400 dark:text-gray-500">
            <p className="text-lg font-medium mb-2">
              AI 暮らしアシスタント
            </p>
            <p className="text-sm">
              日常生活の疑問を何でも聞いてください
            </p>
          </div>
        </div>
      )}

      {/* 各メッセージを表示する */}
      {messages.map((message, index) => (
        <ChatMessage key={index} message={message} />
      ))}

      {/* ストリーミング中のメッセージを表示する */}
      {streamingText && (
        <ChatMessage
          message={{ role: "assistant", content: streamingText }}
        />
      )}

      {/* 自動スクロール用のダミー要素 */}
      <div ref={bottomRef} />
    </div>
  );
}
