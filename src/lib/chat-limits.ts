/**
 * チャット送信の入力上限に関する共有定義
 *
 * 設計判断: これらの上限はサーバー（`src/app/api/chat/route.ts` の検証側）と
 * クライアント（`src/app/page.tsx` / `src/components/ChatInput.tsx` の送信側）の
 * **両方**が同じ値を知っていて初めて意味を持つ。以前は上限がサーバー側にしか
 * 無かったため、クライアントは上限を超える会話履歴・本文をそのまま送り、
 * 必ず 400 になるリクエストを往復させてからエラーを表示していた。
 * とくに会話履歴の件数上限は、履歴が増える一方で減らないため
 * **一度超えると以降どの送信も 400 になり、チャットが再読み込みするまで使えなくなる**。
 * 唯一の参照元をここに置き、両側が必ず同じ値を使うようにする
 * （`src/lib/sse.ts` と同じ「送信側と受信側で共有する契約」の置き方。
 * §6 定数・ラベルの一元管理／マジックナンバーを避ける）。
 */
import type { Message } from "./types";

/** 1 リクエストで受け付ける会話履歴の最大メッセージ数（無制限の履歴送信による
 * トークン浪費・リソース枯渇を防ぐ。サーバーはこれを超える配列を 400 で弾き、
 * クライアントは送信前にこの件数まで古い発言を切り落とす）。 */
export const MAX_MESSAGE_COUNT = 50;

/** 1 メッセージ本文の最大文字数（巨大ボディをそのまま Claude へ転送して
 * 課金・メモリを浪費させられないようにする入力上限）。 */
export const MAX_CONTENT_LENGTH = 4000;

/**
 * 送信する会話履歴を上限件数まで切り詰める。
 *
 * <p>単純に直近 {@link MAX_MESSAGE_COUNT} 件を切り出すだけでは足りない。
 * 履歴は user / assistant が交互に並ぶため、切り出した窓の先頭が assistant 発言に
 * なることがある。Claude の Messages API は**最初のメッセージが user ロールである
 * ことを要求する**ので、そのまま送ると上流が 400 を返してしまう。
 * そこで窓の先頭が user 発言になるまで先頭を捨てる（捨てるのは常に古い側だけなので、
 * 直近のやり取りは必ず残る）。
 *
 * 純粋関数（引数以外の状態を見ず、渡された配列も変更しない）にしてあるため、
 * 画面を起動しなくても単体テストで境界値を確認できる（§10 ロジックと UI の分離）。
 *
 * @param messages - 画面が保持している会話履歴（末尾が最新）
 * @returns API へ送ってよい、user 発言で始まる直近 {@link MAX_MESSAGE_COUNT} 件以内の履歴。
 *          user 発言が 1 件も残らない場合は空配列（送信側が呼ぶ限り、末尾は必ず
 *          今回のユーザー入力なので空にはならない）
 */
export function trimHistoryForRequest(
  messages: readonly Message[]
): Message[] {
  // 直近 MAX_MESSAGE_COUNT 件だけを切り出す（古い側から捨てる）
  const recent = messages.slice(-MAX_MESSAGE_COUNT);

  // 窓の先頭が user 発言になる位置を探す（assistant で始まる窓は上流が 400 にするため）
  let start = 0;
  // 先頭が user 以外である間、開始位置を 1 つずつ後ろへずらす
  while (start < recent.length && recent[start].role !== "user") {
    start += 1;
  }

  // user 発言から始まる部分だけを返す
  return recent.slice(start);
}
