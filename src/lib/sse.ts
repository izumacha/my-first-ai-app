/**
 * SSE（Server-Sent Events）のフレーム書式に関する共有定義
 *
 * 設計判断: この書式はサーバー（`src/app/api/chat/route.ts` の送信側）と
 * クライアント（`src/app/page.tsx` の読み取り側）の**両方**が同じ約束事に従って
 * 初めて成立する。以前は両者が `"data: "` / `"[DONE]"` という文字列と、
 * プレフィックス長を表す裸の数値 `6` をそれぞれ直書きしていたため、
 * 片方だけ書き換えると型チェックもテストも通ったまま解析が静かに壊れる状態だった。
 * 唯一の参照元をここに置き、両側が必ず同じ値を使うようにする
 * （§6 定数・ラベルの一元管理／マジック文字列・マジックナンバーを避ける）。
 */

/** SSE の各行に付く本文プレフィックス。この後ろに 1 件分のデータが続く */
export const SSE_DATA_PREFIX = "data: ";

/** ストリームの終わりを伝える番兵。送信側が最後に流し、読み取り側はこれで読み取りを終える */
export const SSE_DONE_MARKER = "[DONE]";

/**
 * 1 件分のデータを SSE のフレーム（`data: <本文>` ＋ 空行）へ整形する。
 * 区切りの空行を書き忘れるとイベントが確定せず受信側に届かないため、
 * 組み立てもこの 1 か所に閉じ込める。
 * @param payload - data 行に載せる本文（このアプリでは JSON 文字列）
 * @returns SSE の 1 フレームを表す文字列
 */
export function formatSseFrame(payload: string): string {
  // プレフィックスと本文を連結し、イベントの終わりを示す空行（改行 2 つ）で閉じる
  return `${SSE_DATA_PREFIX}${payload}\n\n`;
}

/**
 * SSE の 1 行からデータ部分を取り出す。
 * データ行でない行（フレーム区切りの空行やコメント行）は null を返す。
 * @param line - 改行で分割した 1 行
 * @returns データ部分の文字列。データ行でなければ null
 */
export function parseSseDataLine(line: string): string | null {
  // 行末の復帰文字（CR）を落としてから判定する。
  // SSE の行区切りは LF だけでなく CRLF・CR も認められており、途中の
  // プロキシや CDN が CRLF で流してくることがある。CR を残したままだと
  // 本文の末尾に \r が付き、終端の番兵と文字列比較したときに一致しない。
  // JSON としては CR は空白なので解析は通ってしまい、「本文は届くのに
  // 完了だけ検出できない」＝完全な回答が毎回「中断された」と誤判定される
  const withoutCarriageReturn = line.endsWith("\r") ? line.slice(0, -1) : line;
  // データ行でなければ取り出すものが無いので null を返す
  if (!withoutCarriageReturn.startsWith(SSE_DATA_PREFIX)) {
    return null;
  }
  // プレフィックスの長さ分だけ読み飛ばして本文を取り出す（長さは定数から導く）
  return withoutCarriageReturn.slice(SSE_DATA_PREFIX.length);
}
