/**
 * チャット入力フォームコンポーネント
 * テキスト入力欄と送信ボタンを提供する。
 */
"use client";

import { useState } from "react";
// 送信してよい本文かを判定する共有の規則（定義元は @/lib/chat-limits）
import { findContentProblem } from "@/lib/chat-limits";

/** ChatInput コンポーネントの Props */
interface ChatInputProps {
  /** メッセージ送信時に呼ばれるコールバック関数。
   * **受け付けたかどうかを返す。** false のとき入力欄は入力を消さない:
   * 受け付けていない送信で入力を消すと、送られも残りもせず理由も出ないまま
   * 打った文章だけが消える */
  onSend: (message: string) => boolean;
  /** 直前の送信についての通知（画面上部のエラー）を消すコールバック関数。
   * 送信を止めたときに呼ぶ。呼ばないと、前回の失敗の通知（429 など）が
   * 残ったまま入力欄の下にも別の理由が出て、role="alert" が 2 つ同時に並び、
   * いま行った操作と関係の無い理由まで読み上げられてしまう */
  onClearError: () => void;
  /** 送信中かどうか（true の間は送信ボタンを無効化する） */
  isLoading: boolean;
}

/**
 * チャットの入力フォームを表示するコンポーネント
 * Enter キーまたは送信ボタンでメッセージを送信する。
 */
export default function ChatInput({
  onSend,
  onClearError,
  isLoading,
}: ChatInputProps) {
  // 入力欄のテキストを管理する state
  const [input, setInput] = useState("");
  // 送信前の検証で弾いた理由を保持する state（問題が無ければ null）。
  // attempt（何回目の拒否か）を一緒に持つのは、同じ文言で再び弾かれたときに
  // React が「値が変わっていない」と判断して再描画を省き、role="alert" が
  // 読み上げ直されないため。この値を key にして要素を作り直させる
  const [inputError, setInputError] = useState<{
    message: string;
    attempt: number;
  } | null>(null);

  /**
   * フォーム送信時のハンドラー
   * 送ってよい本文なら onSend を呼び、入力欄をクリアする。
   * 送れない本文（空・上限超過）は理由を表示して止め、入力はそのまま残す。
   */
  const handleSubmit = (e: React.FormEvent) => {
    // ページ遷移を防ぐ
    e.preventDefault();

    // 入力値の前後の空白を除去する
    const trimmed = input.trim();

    // 送ってよい本文かを共有の規則で判定する。問題があればここで止める。
    // 送ってしまうと、サーバーが 400 を返す一方で会話履歴には残るため、
    // 以降のすべての送信が同じ 400 になり、再読み込みするまで会話を続けられなくなる。
    // 入力はあえて消さない（消すと、長文を貼り付けた人がその文章ごと失う）。
    //
    // 空文字もこの規則で弾く。ただし**これは防御であって、通常は到達しない**:
    // 送信ボタンは空白だけの入力では無効になり、既定の送信ボタンが無効な間は
    // Enter による暗黙の送信も起きないため、実ブラウザからこの分岐へは来ない。
    // 手前で早期 return するのをやめてあるのは、無効化を外した／別の送信手段が
    // 増えたときに「空の本文が黙って無視される」状態へ戻らないようにするため
    // （判定の分岐を 1 か所に保つ意味もある）
    const problem = findContentProblem(trimmed);
    if (problem) {
      // 直前の送信についての通知（画面上部のエラー）を消す。
      // 消さないと、前回の失敗の通知と今回の理由が role="alert" として 2 つ並び、
      // いま行った操作と関係の無い理由まで読み上げられる
      onClearError();
      // 拒否の回数を進めて記録する（同じ文言でも読み上げが再び走るようにする）
      setInputError((previous) => ({
        message: problem,
        attempt: (previous?.attempt ?? 0) + 1,
      }));
      return;
    }

    // 検証を通ったので、前回の理由表示があれば消す
    setInputError(null);

    // 親コンポーネントにメッセージを渡し、受け付けられたかを受け取る
    const accepted = onSend(trimmed);

    // 受け付けられなかった場合は入力を残す（打った文章を失わせない）
    if (!accepted) {
      return;
    }

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
        <p
          // 拒否のたびに key が変わるので要素が作り直され、同じ文言でも読み上げ直される
          key={inputError.attempt}
          // role="alert" だけで読み上げる。入力欄から aria-describedby でも
          // 結び付けると、同じ文章が「通知」と「入力欄の説明」の 2 回読まれる。
          // 状態そのものは aria-invalid が伝えるので、文章の紐付けは重ねない
          role="alert"
          className="text-sm text-red-700 dark:text-red-300"
        >
          {inputError.message}
        </p>
      )}
    </form>
  );
}
