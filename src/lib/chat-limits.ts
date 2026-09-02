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

/** 本文が上限を超えたときにユーザーへ見せる文言（§6 UI 文言は一元管理）。
 * サーバーの検証（`route.ts`）と、送信前に弾く入力欄（`ChatInput.tsx`）の両方が
 * これを使う。片方に書き写すと、上限値を変えたときに文言だけが古い値のまま残る。 */
export const CONTENT_TOO_LONG_MESSAGE = `メッセージ本文が上限（${MAX_CONTENT_LENGTH} 文字）を超えています。`;

/** 上限を超えた assistant 発言を切り詰めたときに末尾へ付ける印。
 * 印なしで切ると、AI から見て「そこで終わった回答」と区別が付かず、
 * 続きを尋ねたときに省略された部分を踏まえない答えが返る。 */
const OMITTED_ANSWER_SUFFIX = "\n\n（以前の回答はここで省略されました）";

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

  // user 発言から始まる部分だけを取り出し、assistant 発言の本文は受付上限に収めて返す
  return recent.slice(start).map(capAssistantContent);
}

/**
 * assistant 発言の本文だけを受付上限の文字数に収める。
 *
 * <p>**assistant 発言は上流 Claude の回答なのでこちら側では長さを制御できない**。
 * max_tokens を広げているカテゴリ（料理・手続き）では上限を超える回答が返りうる。
 * それが履歴に入ると、サーバーの検証が「メッセージ本文が上限を超えています」で
 * 400 を返し、しかもその発言が 50 件の窓から抜けるには往復が必要なのに往復自体が
 * 全部 400 になるため、件数上限のときとまったく同じ「再読み込みするまで復帰
 * できない」状態になる。発言ごと捨てず切り詰めるのは、会話のターン構成
 * （誰がいつ何を言ったか）を保ったまま送れるようにするため。画面に表示する履歴は
 * 切り詰めないので、ユーザーから見える回答が欠けることはない。
 *
 * <p><b>user 発言は切り詰めない。</b> こちらはユーザーが打った文章そのものなので、
 * 黙って削ると「質問が途中で切れたことに気づけないまま送信される」ことになる
 * （入力欄に maxLength を付けないのと同じ理由。§7 状態はテキストで伝える）。
 * 上限を超えた user 発言はそのまま送り、サーバーが理由付きの 400 を返して
 * 画面に表示されるほうが「何が起きたか」が伝わる。
 *
 * @param message - 送信候補のメッセージ
 * @returns assistant 発言なら本文が上限以内に収まったもの、それ以外はそのまま
 *          （元のオブジェクトは変更しない）
 */
function capAssistantContent(message: Message): Message {
  // user 発言は削らずそのまま送る（超過はサーバーが理由付きの 400 で知らせる）
  if (message.role !== "assistant") {
    return message;
  }
  // 上限以内ならそのまま使う（無駄なオブジェクト生成もしない）
  if (message.content.length <= MAX_CONTENT_LENGTH) {
    return message;
  }

  // 末尾に付ける印の分だけ手前で切る（印を含めて上限に収める）。
  // 印を付けずに切ると、AI から見て「そこで終わった回答」と区別が付かない。
  // さらに、画面側が付けた「中断されました」の印は末尾にあるため、
  // 素朴に末尾から削ると真っ先に消えてしまい、印を付けた意味が無くなる
  let end = MAX_CONTENT_LENGTH - OMITTED_ANSWER_SUFFIX.length;
  // 切り口がサロゲートペア（絵文字など 2 単位で 1 文字を表す並び）の途中なら 1 つ手前で切る。
  // 片割れだけ残すと文字として成立しない値を上流へ送ることになる
  if (isHighSurrogate(message.content.charCodeAt(end - 1))) {
    end -= 1;
  }

  // ロールはそのままに、切り詰めた本文＋省略の印を持つ新しいメッセージを返す
  return {
    role: message.role,
    content: `${message.content.slice(0, end)}${OMITTED_ANSWER_SUFFIX}`,
  };
}

/**
 * 文字コードがサロゲートペアの前半（上位サロゲート）かを判定する。
 * @param code - 判定する UTF-16 の符号単位
 * @returns 上位サロゲートなら true
 */
function isHighSurrogate(code: number): boolean {
  // UTF-16 で上位サロゲートに割り当てられている範囲かを調べる
  return code >= 0xd800 && code <= 0xdbff;
}
