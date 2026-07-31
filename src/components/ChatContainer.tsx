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
    // OS 側で「視差効果を減らす」が有効かを調べる（未対応環境では false 扱い）。
    // ストリーミング中は差分ごとに自動スクロールが走るため、動きに敏感なユーザーには
    // 負担が大きい。§7「prefers-reduced-motion を尊重する」に従って挙動を切り替える
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // 動きを減らす設定なら瞬間移動（auto）、そうでなければスムーズにスクロールする
    bottomRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [messages, streamingText]);

  return (
    // メッセージ一覧のスクロール可能なコンテナ。
    // 画面の主コンテンツなので <main> ランドマークにし、スクリーンリーダーの
    // ランドマーク移動で会話本文へ直接ジャンプできるようにする（§7 セマンティック HTML）
    <main aria-label="会話" className="flex-1 overflow-y-auto p-4">
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
    </main>
  );
}
