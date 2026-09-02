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

/**
 * SSE のストリームを最後まで読み、届いた回答本文と完了したかどうかを返す。
 *
 * <p>読み取りループを画面から切り離すのは 2 つの理由がある。
 * (1) `page.tsx` 側に可変状態（蓄積・行バッファ・番兵・読み飛ばし）が 5 つ並び、
 * 内側の finally → 外側の catch → 外側の finally という実行順に依存して
 * どのエラー表示が勝つかが決まる状態になっていた。順序を崩す改修が事故になりやすい。
 * (2) ここは実質的に純粋な変換（バイト列 → 本文＋完了したか）なので、書式・行区切りと
 * 同じこのモジュールに置けば `tests/sse.test.ts` の契約テストの射程に入る。
 *
 * <p>**例外はそのまま呼び出し元へ投げる。** 途中で切れた配信でも受信済みの本文は
 * 画面に残す必要があるため、呼び出し元は `onText` で受け取った最新の本文を使う
 * （関数の戻り値は完了した場合にしか得られない）。
 *
 * @param reader - レスポンスボディの読み取り口
 * @param onText - 本文が伸びるたびに呼ばれるコールバック（引数は先頭からの累積）
 * @returns 受信した本文と、完了として扱ってよいか（終端の番兵を受け取り、かつ
 *          読み飛ばした差分が無い場合だけ true）
 */
export async function readSseAnswer(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onText: (text: string) => void
): Promise<{ text: string; completed: boolean }> {
  // バイト列を文字列へ戻すデコーダーを用意する
  const decoder = new TextDecoder();
  // 受信した本文を先頭から蓄積する
  let accumulated = "";
  // チャンクの切れ目で分断された「行の途中」を次のチャンクまで持ち越すバッファ。
  // read() は行境界と無関係な位置でデータを区切るため、バッファ無しだと
  // 分断された JSON がパース失敗として捨てられ、回答の文字が欠落してしまう
  let lineBuffer = "";
  // 終端の番兵 [DONE] を受け取ったか
  let sawDone = false;
  // 解析できずに読み飛ばした差分があったか（回答に欠けがある印）
  let droppedFrame = false;

  // 終端の番兵を受け取るまで読み続ける
  while (!sawDone) {
    // 次のかたまりを読み取る
    const { done, value } = await reader.read();

    // ストリームが終わったら抜ける（番兵が来ていなければ未完了として扱われる）
    if (done) break;

    // バイナリデータを文字列にデコードし、持ち越し分と連結する
    lineBuffer += decoder.decode(value, { stream: true });

    // SSE 形式の行に切り分ける。未完の行は次のチャンクへ持ち越す
    const { lines, remainder } = splitSseLines(lineBuffer);
    lineBuffer = remainder;

    // 完結した行を順に処理する
    for (const line of lines) {
      // データ行なら本文を取り出す（データ行でなければ null が返る）
      const data = parseSseDataLine(line);

      // データ行でない行（フレーム区切りの空行など）は読み飛ばす
      if (data === null) {
        continue;
      }

      // 終端の番兵なら読み取り全体を完了させる
      if (data === SSE_DONE_MARKER) {
        sawDone = true;
        break;
      }

      try {
        // JSON をパースしてテキスト差分を取得する
        const parsed = JSON.parse(data) as { text?: unknown };
        // 期待した形（text が文字列）でなければ差分として使えない。
        // 型を確かめずに足すと "undefined" や数値が本文へ紛れ込み、
        // しかも解析は成功しているので「完全な回答」として確定してしまう
        if (typeof parsed.text !== "string") {
          throw new TypeError("差分の形式が想定と異なります");
        }
        // 蓄積テキストに差分を追加する
        accumulated += parsed.text;
        // 伸びた本文を呼び出し元へ渡す（画面の途中表示と、失敗時の取り出しに使う）
        onText(accumulated);
      } catch (parseError) {
        // 壊れた差分は表示できないので飛ばすが、黙って捨てない。
        // 捨てた事実を覚えておかないと、[DONE] は普通に届くため
        // 「欠けのある回答」が完全な回答として確定してしまう
        // （未完了の回答には必ず印を付ける、という約束が崩れる）。
        //
        // ログに残すのは最初の 1 件だけにする。ここは行ごとのループなので、
        // 壊れた差分を流し続ける上流にあたると回答 1 本で数百件のログが出て
        // ブラウザのコンソールが埋まってしまう（読み飛ばした事実は
        // droppedFrame が 1 度覚えれば印を付けるのに足りる）
        if (!droppedFrame) {
          console.debug("差分の解析に失敗したため読み飛ばしました:", parseError);
        }
        droppedFrame = true;
      }
    }
  }

  // 本文と、完了として扱ってよいかを返す。
  // 番兵を受け取っていても読み飛ばした差分があれば「欠けのある回答」なので完了にしない
  return { text: accumulated, completed: sawDone && !droppedFrame };
}
