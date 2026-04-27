/**
 * メインチャット画面
 * カテゴリ選択・メッセージ一覧・入力フォームを統合するページコンポーネント。
 */
"use client";

import { useState, useCallback } from "react";
import ChatContainer from "@/components/ChatContainer";
import ChatInput from "@/components/ChatInput";
import CategoryChips from "@/components/CategoryChips";
import type { Message, CategoryId } from "@/lib/types";

/**
 * チャット画面のメインページコンポーネント
 * ユーザーの入力を受け取り、API にストリーミングリクエストを送信し、
 * AI の回答をリアルタイムに表示する。
 */
export default function Home() {
  // 会話履歴を管理する state
  const [messages, setMessages] = useState<Message[]>([]);
  // 選択中のカテゴリを管理する state
  const [category, setCategory] = useState<CategoryId>("general");
  // AI のストリーミング中テキストを管理する state
  const [streamingText, setStreamingText] = useState("");
  // ローディング状態を管理する state
  const [isLoading, setIsLoading] = useState(false);
  // エラーメッセージを管理する state
  const [error, setError] = useState<string | null>(null);

  /**
   * メッセージ送信処理
   * ユーザーのメッセージを会話履歴に追加し、API にストリーミングリクエストを送る。
   */
  const handleSend = useCallback(
    async (content: string) => {
      // エラー表示をクリアする
      setError(null);

      // ユーザーのメッセージオブジェクトを作成する
      const userMessage: Message = { role: "user", content };

      // 会話履歴にユーザーメッセージを追加する
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);

      // ローディング状態を開始する
      setIsLoading(true);
      // ストリーミングテキストを空にリセットする
      setStreamingText("");

      try {
        // チャット API にリクエストを送信する
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: updatedMessages,
            category,
          }),
        });

        // レスポンスがエラーの場合はエラーメッセージを表示する
        if (!response.ok) {
          const errorData = await response.json();
          setError(
            errorData.error ?? "エラーが発生しました。もう一度お試しください。"
          );
          setIsLoading(false);
          return;
        }

        // レスポンスボディのリーダーを取得する
        const reader = response.body?.getReader();

        // リーダーが取得できない場合はエラー
        if (!reader) {
          setError("ストリーミングの開始に失敗しました。");
          setIsLoading(false);
          return;
        }

        // テキストデコーダーを準備する
        const decoder = new TextDecoder();
        // ストリーミングで受信したテキストを蓄積する変数
        let accumulated = "";

        // ストリームからデータを順次読み取るループ
        while (true) {
          // チャンクを読み取る
          const { done, value } = await reader.read();

          // ストリーム終了なら停止する
          if (done) break;

          // バイナリデータを文字列にデコードする
          const chunk = decoder.decode(value, { stream: true });

          // SSE 形式の行を分割して処理する
          const lines = chunk.split("\n");

          for (const line of lines) {
            // "data: " で始まる行のみ処理する
            if (line.startsWith("data: ")) {
              // "data: " プレフィックスを除去してデータ部分を取得する
              const data = line.slice(6);

              // ストリーム終了マーカーなら読み取りを完了する
              if (data === "[DONE]") {
                break;
              }

              try {
                // JSON をパースしてテキスト差分を取得する
                const parsed = JSON.parse(data) as { text: string };
                // 蓄積テキストに差分を追加する
                accumulated += parsed.text;
                // ストリーミング表示を更新する
                setStreamingText(accumulated);
              } catch {
                // JSON パースに失敗した行は無視する
              }
            }
          }
        }

        // ストリーミング完了後、AI メッセージを会話履歴に追加する
        if (accumulated) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
        }

        // ストリーミングテキストをクリアする
        setStreamingText("");
      } catch {
        // ネットワークエラーなどの場合にメッセージを表示する
        setError("通信エラーが発生しました。接続を確認してください。");
      } finally {
        // ローディング状態を終了する
        setIsLoading(false);
      }
    },
    [messages, category]
  );

  return (
    // 画面全体を縦いっぱいに使うコンテナ
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      {/* ヘッダー：アプリタイトルを表示する */}
      <header className="flex items-center justify-center px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-lg font-bold">AI 暮らしアシスタント</h1>
      </header>

      {/* カテゴリ選択チップを表示する */}
      <CategoryChips selected={category} onSelect={setCategory} />

      {/* エラーメッセージがあれば表示する */}
      {error && (
        <div className="mx-4 mt-2 rounded-lg bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* チャットメッセージ一覧を表示する */}
      <ChatContainer messages={messages} streamingText={streamingText} />

      {/* メッセージ入力フォームを表示する */}
      <ChatInput onSend={handleSend} isLoading={isLoading} />
    </div>
  );
}
