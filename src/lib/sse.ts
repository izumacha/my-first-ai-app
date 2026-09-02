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
  // データ行でなければ取り出すものが無いので null を返す
  if (!line.startsWith(SSE_DATA_PREFIX)) {
    return null;
  }
  // プレフィックスの長さ分だけ読み飛ばして本文を取り出す（長さは定数から導く）
  return line.slice(SSE_DATA_PREFIX.length);
}

/** SSE の行区切り。仕様では CRLF・CR・LF のいずれも認められている。
 * LF だけで割ると、CR だけで区切るストリームでは 1 行も切り出せず応答が
 * 丸ごと捨てられ、CRLF では本文の末尾に \r が残って終端の番兵と一致しなくなる
 * （本文は届くのに完了だけ検出できず、完全な回答が「中断された」と誤判定される）。 */
const SSE_LINE_SEPARATOR = /\r\n|\r|\n/;

/**
 * 受信バッファを SSE の行へ切り分ける。
 *
 * <p>読み取りは行境界と無関係な位置で区切られて届くため、最後の要素は
 * 「行の途中」の可能性がある。それを次の読み取りへ持ち越せるよう、
 * 完結した行と持ち越し分を分けて返す。
 *
 * <p>行区切りの規則を書式と同じこのモジュールに置くのは、読み取り側だけが
 * 知っている状態にすると `tests/sse.test.ts` の契約テストの目が届かなくなるため。
 *
 * @param buffer - 前回の持ち越しと今回の受信を連結した文字列
 * @returns 完結した行の配列と、次へ持ち越す未完の行
 */
export function splitSseLines(buffer: string): {
  lines: string[];
  remainder: string;
} {
  // 行区切りで分割する（最後の要素は未完の行の可能性がある）
  const parts = buffer.split(SSE_LINE_SEPARATOR);
  // 最後の要素を持ち越し分として取り出す（必ず 1 要素はあるので空文字にはならない）
  const remainder = parts.pop() ?? "";
  // 完結した行と持ち越し分を返す
  return { lines: parts, remainder };
}
