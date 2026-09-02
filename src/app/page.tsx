/**
 * メインチャット画面
 * カテゴリ選択・メッセージ一覧・入力フォームを統合するページコンポーネント。
 */
"use client";

import { useState, useCallback } from "react";
import ChatContainer from "@/components/ChatContainer";
import ChatInput from "@/components/ChatInput";
import CategoryChips from "@/components/CategoryChips";
import { readSseAnswer } from "@/lib/sse";
// 送信する会話履歴をサーバーの受付上限まで切り詰めるヘルパー（上限の定義元は @/lib/chat-limits）
import {
  findContentProblem,
  TRUNCATED_ANSWER_SUFFIX,
  trimHistoryForRequest,
} from "@/lib/chat-limits";
import type { Message, CategoryId } from "@/lib/types";

/** 画面に表示する文言（§6 UI 文言は一元管理）。
 *
 * <p>ここに置くのは**表示専用**の文言だけ。サーバーと値や文言を共有するもの
 * （入力上限の超過・履歴に付ける印）は `@/lib/chat-limits` にあり、
 * サーバーが返す文言は `route.ts` の `ERROR_MESSAGES` にある。
 * 「誰と共有するか」で置き場所を分け、同じ種類の文言が散らばらないようにする。 */
const MESSAGES = {
  /** サーバーが JSON でないエラー応答を返したときの汎用文言 */
  genericError: "エラーが発生しました。もう一度お試しください。",
  /** レスポンスボディの読み取り口が得られなかったときの文言 */
  streamStartFailed: "ストリーミングの開始に失敗しました。",
  /** 通信そのものが失敗したときの文言 */
  networkError: "通信エラーが発生しました。接続を確認してください。",
  /** 回答を 1 文字も受け取れなかったときの文言。
   * 上流が本文を返さずに正常終了する（長さ上限に本文なしで達した等）ことは起こりうる。 */
  emptyAnswer: "回答を受け取れませんでした。もう一度お試しください。",
  /** 配信が最後まで届かなかったときの文言（1 文字も届かなかった場合も含む）。
   * サーバーは「完了前に終わった」ことを error として伝えるが、その原因は
   * 通信障害とは限らない（プラットフォームの実行時間上限で打ち切られる等）。
   * ここで networkError（「接続を確認してください」）を出すと、接続に問題が
   * 無いのに無関係な確認を促すことになる（`TRUNCATED_ANSWER_SUFFIX` が
   * 「中断」という語を避けているのと同じ理由）。 */
  answerInterrupted: "回答を最後まで受け取れませんでした。もう一度お試しください。",
} as const;

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
   * 画面上部の通知（前回の送信の結果）を消す処理
   * 入力欄が送信を止めたときに呼ばれ、関係の無い古い通知が残らないようにする。
   */
  const clearError = useCallback(() => {
    // エラー表示を消す
    setError(null);
  }, []);

  /**
   * メッセージ送信処理
   * ユーザーのメッセージを会話履歴に追加し、API にストリーミングリクエストを送る。
   */
  const handleSend = useCallback(
    async (content: string) => {
      // エラー表示をクリアする
      setError(null);

      // 上限を超える本文は履歴に積まない。積むとサーバーが 400 を返す一方で
      // 履歴には残り続け、以降のすべての送信が同じ 400 になって復帰できなくなる。
      // 入力欄側も同じ規則（findContentProblem）で先に弾くが、あちらは
      // 「入力を消さずに理由を見せる」表示のための検証で、履歴を守るのはこの層。
      // 入力欄を経由しない送信経路が増えても、必ずここを通る
      const contentProblem = findContentProblem(content);
      if (contentProblem) {
        setError(contentProblem);
        return;
      }

      // ユーザーのメッセージオブジェクトを作成する
      const userMessage: Message = { role: "user", content };

      // 会話履歴にユーザーメッセージを追加する。
      // 更新は関数形式で行う: 直前の値を捕まえた配列をそのまま渡すと、再描画の前に
      // 送信が 2 回重なったときに片方の発言が丸ごと消える（送信ボタンの無効化で
      // today は防げているが、入力欄を経由しない送信経路が増えると効かない）
      const updatedMessages = [...messages, userMessage];
      setMessages((previous) => [...previous, userMessage]);

      // 応答の読み取りに入ったかどうか。外側の catch が「通信エラー」と
      // 断定してよいかの判断に使う。読み取りに入っていれば接続は成立して
      // いるので、そこから先の失敗は「配信が最後まで届かなかった」であって
      // 接続の問題とは限らない（プラットフォームの実行時間上限など）
      let startedStreaming = false;

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
              : MESSAGES.genericError
          );
          // 早期リターンする（ローディング解除は finally が行う）
          return;
        }

        // レスポンスボディのリーダーを取得する
        const reader = response.body?.getReader();

        // リーダーが取得できない場合はエラー
        if (!reader) {
          setError(MESSAGES.streamStartFailed);
          // 早期リターンする（ローディング解除は finally が行う）
          return;
        }

        // ここまで来たら応答の読み取りに入る（接続は成立している）
        startedStreaming = true;

        // 受信済みの本文を保持する（途中で切れても画面に残せるよう、読み取り側から
        // コールバックで受け取る。読み取りが例外で終わると戻り値は得られない）
        let received = "";
        // 完了として扱ってよいか（終端の番兵を受け取り、読み飛ばしも無かったか）
        let completed = false;

        try {
          // SSE の読み取りは @/lib/sse に集約している（書式・行区切りと同じ場所）。
          // 本文が伸びるたびに受け取り、画面の途中表示を更新する
          const answer = await readSseAnswer(reader, (text) => {
            received = text;
            setStreamingText(text);
          });
          // 完了したかを控える（例外で終わった場合はここへ来ないので false のまま）
          completed = answer.completed;


          // ここへ来たのは読み取りが例外なく終わったときだけ（＝通信は成功した）。
          // それでも 1 文字も受け取れていないなら、黙って何も起きなかったように
          // 終わらせない。ローディングだけ止まって画面に何も出ないと、
          // ユーザーは失敗に気づかず再送して上流の呼び出しを重ねる。
          // finally 側で判定すると失敗経路でも走り、外側の catch が上書きする順序に
          // 依存した「たまたま正しい」状態になる
          if (!received.trim()) {
            // 1 文字も受け取れなかった理由は 2 通りある。完了していれば
            // 「本文の無い回答が返った」、完了していなければ「途中で終わった」で、
            // 後者に「回答を受け取れませんでした」と出すと、何も送られなかったように
            // 見えて実際（途中で切れた）と食い違う
            setError(
              completed ? MESSAGES.emptyAnswer : MESSAGES.answerInterrupted
            );
          }
        } finally {
          // 読み取りを終えた reader を必ず解放する。[DONE] を受信して読み取りを
          // 終えた場合、レスポンスボディは reader にロックされたまま未消費として
          // 残るため、ブラウザが HTTP コネクションを再利用できず握ったままになる。
          // 成功・失敗のどちらの経路でも通るこの finally で解放する
          // （§8 リソースを確実に解放する）
          await reader.cancel().catch((cancelError: unknown) => {
            // 既にエラーで終了したストリームの cancel は reject するが、目的は解放なので
            // 失敗しても実害は無い。それでも黙って捨てず debug ログには残す（§6）
            console.debug("ストリームの解放に失敗しました:", cancelError);
          });
          // 成功・途中失敗のどちらでも、受信済みのテキストがあれば会話履歴に残す。
          // ここで確定させないと、途中でストリームが切れたときに受信済みの回答が
          // 消えたうえ、宙に浮いた吹き出しが次の送信まで表示され続けてしまう。
          // 空白だけの回答は残さない。残すとサーバーの検証（本文が空）で以降の
          // 送信がすべて 400 になり、往復が成立しないので窓からも抜けない
          if (received.trim()) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                // 途中で切れた回答には印を付ける。印が無いと画面上は完全な回答と
                // 見分けが付かず、しかも次の質問でこの欠けた回答が文脈として
                // 送り返され、AI は続きがある前提で答えてしまう
                content: completed
                  ? received
                  : `${received}${TRUNCATED_ANSWER_SUFFIX}`,
              },
            ]);
          }
          // ストリーミング表示を必ずクリアする（エラー時の吹き出し残留を防ぐ）
          setStreamingText("");
        }
      } catch (requestError) {
        // 読み取りに入ったあとの失敗は、サーバーが「完了前に終わった」ことを
        // error で伝えてきただけかもしれない（プラットフォームの実行時間上限
        // などで、接続そのものは正常）。1 文字も届いていない場合も同じで、
        // むしろ画面に印付きの回答すら出ないぶん誤解を招きやすい。
        // ここで「接続を確認してください」と出すと問題の無い接続を疑わせるので、
        // 接続が成立する前の失敗（fetch 自体の失敗）とだけ文言を分ける
        setError(
          startedStreaming ? MESSAGES.answerInterrupted : MESSAGES.networkError
        );
        // 例外そのものは握り潰さずブラウザのコンソールへ残す（§6）。
        // ここへ来るのは通信の失敗（オフライン等）だけとは限らず、try の中の
        // 不具合もすべて同じ文言に化ける。中身を捨てると、画面に出る文言だけが
        // 残って原因を追う手がかりが消える。
        // ただし、途切れた回答を印付きで残せているケースは長い回答で日常的に
        // 起こりうるので、障害として積み上げず debug に落とす
        // 途切れは日常的に起こるので error では積み上げない。ただし debug だと
        // ブラウザの既定のログレベルでは表示されず、ここへ紛れ込む実装の不具合
        // （try の中で投げられた TypeError 等）が誰にも見えないまま
        // 「回答を最後まで受け取れませんでした」だけが出続ける。既定で見える warn にする
        if (startedStreaming) {
          console.warn("配信が完了前に終わりました:", requestError);
        } else {
          console.error("チャットのリクエストに失敗しました:", requestError);
        }
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
      <ChatInput
        onSend={handleSend}
        onClearError={clearError}
        isLoading={isLoading}
      />
    </div>
  );
}
