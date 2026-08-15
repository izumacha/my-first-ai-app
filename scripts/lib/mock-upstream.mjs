/**
 * Anthropic Messages API のストリーミング応答（SSE）を模倣するモック上流サーバー。
 *
 * 撮影スクリプトは実 API キーでの課金呼び出しを避けるため、アプリの接続先を
 * `ANTHROPIC_BASE_URL` でこのモックへ差し替える（アプリ本体のコードは変更しない）。
 * デモ GIF 撮影とスクリーンショット撮影の両方から使うため、モックの実装は
 * ここ 1 か所に置く（CLAUDE.md §6 DRY）。
 *
 * 呼び出し側は必ず stats.messagesRequests を検査すること。「モックが何回呼ばれたか」は
 * 実 API を叩いていない唯一の機械的な証拠であり、撮影の成否判定に使う（fail-closed）。
 */

// Node 標準の HTTP サーバー（モック上流用）を読み込む
import http from "node:http";

// 待受ポート。0 を渡すと OS が空きポートを割り当てるため、固定番号が他プロセス
// （Linux の ephemeral port 範囲と重なる）に使われていて起動できない、という事故を避けられる
const LISTEN_PORT = 0;
// 待受アドレス（ローカルからのみ到達できるようループバックに限定する）
const LISTEN_HOST = "127.0.0.1";

/**
 * SSE イベントを 1 つ書き出す（event 行 + data 行 + 空行）。
 * @param {import("node:http").ServerResponse} res - 書き出し先のレスポンス
 * @param {string} event - イベント名
 * @param {unknown} data - JSON としてシリアライズするペイロード
 */
function writeEvent(res, event, data) {
  // Anthropic の SSE 形式（event 行と data 行を空行で区切る）で書き出す
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 指定ミリ秒待つ（チャンク送出の間隔をあけるために使う）。
 * @param {number} ms - 待機時間（ミリ秒）
 * @returns {Promise<void>} 指定時間後に解決する Promise
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * モック上流サーバーを起動する。
 * @param {object} options - モックの応答内容を決めるオプション
 * @param {string} options.answer - ストリーミングで返すデモ回答の全文
 * @param {number} options.deltaIntervalMs - チャンク送出の間隔（ミリ秒）
 * @param {number} options.deltaChunkSize - 1 回の text_delta で送る文字数
 * @param {(msg: string) => void} options.log - 警告を出すためのログ関数
 * @returns {Promise<{ server: import("node:http").Server, stats: { messagesRequests: number }, port: number }>}
 *   待受を開始したサーバー・受け取ったリクエスト数のカウンタ・実際の待受ポート
 */
export function startMockUpstream({ answer, deltaIntervalMs, deltaChunkSize, log }) {
  // モックが実際に呼ばれたかを後から検証するためのカウンタ（課金呼び出し防止の要）
  const stats = { messagesRequests: 0 };

  // POST /v1/messages に対して Anthropic のストリーミングイベント列を返すサーバーを作る
  const server = http.createServer(async (req, res) => {
    // メッセージ作成エンドポイント以外は 404 を返す
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    // モックが呼ばれた回数を数える（＝実 API ではなくここへ来た証拠）
    stats.messagesRequests += 1;
    // 相手（next dev）が切断したら送信を打ち切るためのフラグ
    let clientGone = false;
    // 接続が閉じたら以降の書き込みをやめる（破棄済みレスポンスへの write を防ぐ）
    res.once("close", () => {
      clientGone = true;
    });
    // リクエスト本文は読み捨てる（内容によらず固定のデモ回答を返す）
    req.resume();
    // 本文の読み終わりを待つ。中断（aborted）や異常終了でも 'end' は来ないため、
    // 'close' / 'error' でも解決させないとハンドラが永久に待ち続けてプロセスが終わらなくなる
    await new Promise((resolve) => {
      req.once("end", resolve);
      req.once("close", resolve);
      req.once("error", resolve);
    });
    // 待っている間に切断されていたら何も返さず終了する
    if (clientGone) return;
    // SSE 応答ヘッダを返す
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    // message_start: 応答メッセージの開始を通知する
    writeEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_demo_capture",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 1 },
      },
    });
    // content_block_start: テキストブロックの開始を通知する
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    // 回答文を数文字ずつの text_delta として間隔をあけて流す（ストリーミングの再現）
    for (let i = 0; i < answer.length; i += deltaChunkSize) {
      // 途中で相手が切断したら、破棄済みレスポンスへ書き続けず即座に抜ける
      if (clientGone) return;
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: answer.slice(i, i + deltaChunkSize) },
      });
      // 次のチャンクまで少し待つ（体感に近いストリーミング速度にする）
      await sleep(deltaIntervalMs);
    }
    // 送出ループを抜けた後に切断されていたら終了イベントは送らない
    if (clientGone) return;
    // content_block_stop: テキストブロックの終了を通知する
    writeEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    // message_delta: 停止理由と使用量を通知する
    writeEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 300 },
    });
    // message_stop: メッセージ全体の終了を通知する
    writeEvent(res, "message_stop", { type: "message_stop" });
    // レスポンスを閉じる
    res.end();
  });

  // 待受を開始し、開始完了を Promise で返す
  // （ポート使用中などの listen 失敗は 'error' イベントで拒否し、未捕捉例外にしない）
  return new Promise((resolve, reject) => {
    // listen 失敗を Promise の失敗として伝えるハンドラ
    const onListenError = (err) => reject(err);
    server.once("error", onListenError);
    server.listen(LISTEN_PORT, LISTEN_HOST, () => {
      // OS が実際に割り当てたポート番号を読み取る（アプリへ渡す接続先に使う）
      const port = server.address().port;
      // listen 成功後はこのハンドラを外す。付けたままだと解決済み Promise に対する
      // reject になり、以降のサーバーエラーが何の痕跡も残さず消えてしまう（§6）
      server.off("error", onListenError);
      // 以降のエラーは握り潰さずログに残す
      server.on("error", (err) => log(`warning: モック上流でエラーが発生しました: ${err.message}`));
      resolve({ server, stats, port });
    });
  });
}
