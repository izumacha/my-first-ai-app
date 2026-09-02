/**
 * メインチャット画面
 * カテゴリ選択・メッセージ一覧・入力フォームを統合するページコンポーネント。
 */
"use client";

import { useState, useCallback } from "react";
import ChatContainer from "@/components/ChatContainer";
import ChatInput from "@/components/ChatInput";
import CategoryChips from "@/components/CategoryChips";
import { parseSseDataLine, SSE_DONE_MARKER } from "@/lib/sse";
// 送信する会話履歴をサーバーの受付上限まで切り詰めるヘルパー（上限の定義元は @/lib/chat-limits）
import { trimHistoryForRequest } from "@/lib/chat-limits";
import type { Message, CategoryId } from "@/lib/types";

/** 途中で切れた回答の末尾に付ける印（§6 UI 文言は一元管理）。
 * 画面上で「完全な回答」と見分けられるようにするのが主目的だが、この文字列は
 * 次の質問の文脈としてもそのまま送られるため、AI 側も回答が途切れたことを読み取れる。 */
const TRUNCATED_ANSWER_SUFFIX = "\n\n（回答はここで中断されました）";

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
            // 画面には全履歴を残したまま、API へはサーバーが受け付ける件数まで
            // 切り詰めた履歴だけを送る。切り詰めないと会話が続くほど履歴が伸び、
            // 上限を超えた時点から以降のすべての送信が 400 になって会話を続けられなくなる
            messages: trimHistoryForRequest(updatedMessages),
            category,
          }),
        });

        // レスポンスがエラーの場合はエラーメッセージを表示する
        if (!response.ok) {
          // エラーボディを JSON として読む（プロキシの HTML 応答など JSON でない場合は null に倒す）
          const errorData = (await response.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          // サーバの日本語メッセージが文字列で得られればそれを、無ければ汎用文言を表示する
          setError(
            typeof errorData?.error === "string"
              ? errorData.error
              : "エラーが発生しました。もう一度お試しください。"
          );
          // 早期リターンする（ローディング解除は finally が行う）
          return;
        }

        // レスポンスボディのリーダーを取得する
        const reader = response.body?.getReader();

        // リーダーが取得できない場合はエラー
        if (!reader) {
          setError("ストリーミングの開始に失敗しました。");
          // 早期リターンする（ローディング解除は finally が行う）
          return;
        }

        // テキストデコーダーを準備する
        const decoder = new TextDecoder();
        // ストリーミングで受信したテキストを蓄積する変数
        let accumulated = "";
        // 回答が最後まで届いたかどうか（[DONE] を受け取れば完了）。
        // 途中で切れた回答をそのまま履歴に残すと、見た目が完全な回答と変わらず、
        // 次の質問ではその欠けた回答が文脈として送り返されてしまう
        let completed = false;
        // チャンクの切れ目で分断された「行の途中」を次のチャンクまで持ち越すバッファ。
        // reader.read() は行境界と無関係な位置でデータを区切るため、バッファ無しだと
        // 分断された JSON がパース失敗として捨てられ、回答の文字が欠落してしまう
        let lineBuffer = "";
        // 終了マーカー [DONE] を受信したかどうかのフラグ（外側の読み取りループも止めるため）
        let sawDone = false;

        try {
          // ストリームからデータを順次読み取るループ
          while (!sawDone) {
            // チャンクを読み取る
            const { done, value } = await reader.read();

            // ストリーム終了なら停止する
            if (done) break;

            // バイナリデータを文字列にデコードし、持ち越し分と連結する
            lineBuffer += decoder.decode(value, { stream: true });

            // SSE 形式の行を分割する（最後の要素は「行の途中」の可能性がある）
            const lines = lineBuffer.split("\n");
            // 最後の要素は未完の行として次のチャンクへ持ち越す（完結行だけを処理する）
            lineBuffer = lines.pop() ?? "";

            for (const line of lines) {
              // データ行なら本文を取り出す（データ行でなければ null が返る。書式は @/lib/sse に集約）
              const data = parseSseDataLine(line);

              // データ行でない行（フレーム区切りの空行など）は読み飛ばす
              if (data === null) {
                continue;
              }

              // ストリーム終了マーカーなら読み取り全体を完了させる
              if (data === SSE_DONE_MARKER) {
                sawDone = true;
                // 最後まで届いたことを記録する（途中で切れた回答と区別するため）
                completed = true;
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
        } finally {
          // 読み取りを終えた reader を必ず解放する。[DONE] を受信して while を抜けた
          // 場合、レスポンスボディは reader にロックされたまま未消費として残るため、
          // ブラウザが HTTP コネクションを再利用できず握ったままになる。成功・失敗の
          // どちらの経路でも通るこの finally で解放する（§8 リソースを確実に解放する）
          await reader.cancel().catch((cancelError: unknown) => {
            // 既にエラーで終了したストリームの cancel は reject するが、目的は解放なので
            // 失敗しても実害は無い。それでも黙って捨てず debug ログには残す（§6）
            console.debug("ストリームの解放に失敗しました:", cancelError);
          });
          // 成功・途中失敗のどちらでも、受信済みのテキストがあれば会話履歴に残す。
          // ここで確定させないと、途中でストリームが切れたときに受信済みの回答が
          // 消えたうえ、宙に浮いた吹き出しが次の送信まで表示され続けてしまう
          if (accumulated) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                // 途中で切れた回答には印を付ける。印が無いと画面上は完全な回答と
                // 見分けが付かず、しかも次の質問でこの欠けた回答が文脈として
                // 送り返され、AI は続きがある前提で答えてしまう
                content: completed
                  ? accumulated
                  : `${accumulated}${TRUNCATED_ANSWER_SUFFIX}`,
              },
            ]);
          }
          // ストリーミング表示を必ずクリアする（エラー時の吹き出し残留を防ぐ）
          setStreamingText("");
        }
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

      {/* エラーメッセージがあれば表示する（role="alert" でスクリーンリーダーに即時読み上げさせる） */}
      {error && (
        <div
          role="alert"
          className="mx-4 mt-2 rounded-lg bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300"
        >
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
