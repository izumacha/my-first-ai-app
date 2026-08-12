/**
 * デモ GIF の自動撮影スクリプト（上流 Claude API はスタブ）
 *
 * CLAUDE.md §3「見せ方」の宿題に対応する。実 API キーでの課金呼び出しを避けるため、
 * Anthropic Messages API のストリーミング応答を模倣するローカルモックサーバーを立て、
 * `ANTHROPIC_BASE_URL` でアプリをそこへ向ける（アプリ本体のコードは変更しない）。
 *
 * 流れ: モック上流起動 → `next dev` 起動 → Playwright で
 * 「カテゴリ選択 → 質問入力 → ストリーミング回答」を録画 → ffmpeg で GIF 化。
 *
 * 実行: node scripts/capture-demo.mjs
 * 依存: ffmpeg（GIF 変換）, @playwright/test（同梱の chromium）。
 *       `npx playwright install` できない環境では PLAYWRIGHT_CHROMIUM_PATH で
 *       既存の Chromium 実行ファイルを指定できる（scripts/lib/chromium-launch-options.mjs）。
 * 生成物: docs/screenshots/chat-demo.gif
 *
 * 失敗時は必ず throw して GIF を書き換えないこと（fail-closed）。README が参照する
 * 唯一のデモ資産なので、エラー画面や途中で切れた録画を「成功」として上書きすると、
 * 壊れた GIF がそのままコミットされてしまう。
 */

// Node 標準の HTTP サーバー（モック上流用）を読み込む
import http from "node:http";
// TCP サーバー（ポートが空いているかの確認用）を読み込む
import net from "node:net";
// 子プロセス起動（next dev / ffmpeg 実行用）を読み込む
import { spawn, spawnSync } from "node:child_process";
// ファイル操作（GIF サイズ確認・録画一時ディレクトリの削除用）を読み込む
import fs from "node:fs";
// OS 情報（一時ディレクトリの場所）を読み込む
import os from "node:os";
// パス結合ユーティリティを読み込む
import path from "node:path";
// file:// URL をファイルパスへ変換するユーティリティを読み込む
import { fileURLToPath } from "node:url";
// Playwright の chromium ランチャーを読み込む（録画機能つきブラウザ操作）
import { chromium } from "@playwright/test";
// ブラウザ起動オプションの組み立て（E2E 設定と共有。重複定義を避けるため）
import { chromiumLaunchOptions } from "./lib/chromium-launch-options.mjs";

// このスクリプト自身の場所からリポジトリルートを求める（どこから実行しても生成物の場所を固定する）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 定数（マジックナンバーを避けるため一元管理） ----
// モック上流サーバーの待受ポート。0 を渡すと OS が空きポートを割り当てるため、
// 固定番号が他プロセス（Linux の ephemeral port 範囲と重なる）に使われていて
// 起動できない、という事故を避けられる。実際の番号は listen 後に読み取る
const MOCK_UPSTREAM_PORT = 0;
// デモ用に起動する Next.js 開発サーバーのポート（通常の dev と衝突しないよう別番号）
const APP_PORT = 3100;
// アプリの URL（Next.js dev サーバーは 127.0.0.1 だと cross-origin 扱いで
// dev リソースをブロックするため、サーバー自身のオリジンと一致する localhost を使う）
const APP_URL = `http://localhost:${APP_PORT}`;
// 録画の画面サイズ（README 掲載基準の幅 1280px 目安に合わせる）
const VIEWPORT = { width: 1280, height: 800 };
// ストリーミングのチャンク送出間隔（ミリ秒）。実際の体感に近い速度にする
const DELTA_INTERVAL_MS = 45;
// 1 回の text_delta で送る文字数（体感に近いストリーミング速度にするための粒度）
const DELTA_CHUNK_SIZE = 6;
// GIF の上限サイズ（CLAUDE.md §15: 10MB 以下）
const GIF_MAX_BYTES = 10 * 1024 * 1024;
// next dev の起動を待つ上限時間（ミリ秒）
const APP_STARTUP_TIMEOUT_MS = 120_000;
// SIGTERM で終わらない next dev を強制終了するまでの猶予（ミリ秒）
const APP_SHUTDOWN_GRACE_MS = 10_000;
// 回答が出そろってから録画を止めるまでの静止時間（ミリ秒）。
// Playwright の録画は末尾が数秒切り落とされることがあるため、単に「読める間」だけでなく
// 切り落とし分の余白も見込んで長めに取る。ここを削ると GIF が
// 「送信中...」のまま途中で終わり、完成した回答が写らない GIF ができてしまう。
const ANSWER_SETTLE_MS = 6000;
// 生成物の出力先（README が参照するパスに固定。実行時のカレントディレクトリに依存させない）
const GIF_PATH = path.join(REPO_ROOT, "docs", "screenshots", "chat-demo.gif");
// ffmpeg の書き出し先（同じディレクトリの一時ファイル）。完成・サイズ検査を通ってから
// GIF_PATH へ名前を変える。コミット対象へ直接書くと、変換が途中で失敗したときに
// 壊れた GIF が「変更あり」として残り、そのままコミットされてしまう。
// 拡張子を .gif のままにしないと ffmpeg が出力フォーマットを判定できない点に注意。
const GIF_TMP_PATH = path.join(path.dirname(GIF_PATH), ".chat-demo.tmp.gif");

// デモで入力する質問文（ダミー。個人情報を含めない）
const DEMO_QUESTION =
  "冷蔵庫に卵とキャベツが残っています。簡単に作れる夕食のレシピを教えてください。";

// モックが返すデモ回答（スタブであることが撮影上わからないよう、実際の回答らしい文面にする）。
// ChatMessage は本文を Markdown ではなくプレーンテキストとして描画する（whitespace-pre-wrap）ため、
// `**強調**` を書くと GIF にアスタリスクがそのまま写ってしまう。見出しは記号で表現する。
// 絵文字は使わない。撮影に使うヘッドレス Chromium には絵文字フォントが無く、
// 豆腐（□）や別記号のフォールバック字形で焼き込まれてしまううえ、
// フォントの有無で生成物が変わり再現性が失われるため。
const DEMO_ANSWER_LINES = [
  "卵とキャベツがあれば「とん平焼き風オムレツ」がおすすめです！",
  "",
  "【材料（1人分）】",
  "・卵 2個 / キャベツ 1/8玉 / 塩こしょう 少々",
  "・お好みでソース・マヨネーズ・かつお節",
  "",
  "【作り方（約10分）】",
  "1. キャベツを千切りにして耐熱容器で1分半レンジ加熱",
  "2. フライパンで溶き卵を半熟に焼き、キャベツをのせて包む",
  "3. ソースとマヨネーズをかけて完成！",
  "",
  "キャベツの甘みと半熟卵がよく合いますよ。ごはんにもパンにも合うので、ぜひ試してみてください。",
];

// モックが返すデモ回答（各行を改行でつなぐ）
const DEMO_ANSWER = DEMO_ANSWER_LINES.join("\n");

// 回答が最後まで描画されたことを確認するための目印。DEMO_ANSWER の最終行から導出する。
// 文字列を手で書き写すと、回答を書き換えたときに目印だけ古いまま残り、
// 正常な録画を「ストリーミングが途中で切れた」と誤診断してしまう
const ANSWER_TAIL_MARKER = DEMO_ANSWER_LINES[DEMO_ANSWER_LINES.length - 1];

// 撮影で選択するカテゴリのラベル（README の説明文と一致させること）
const DEMO_CATEGORY_LABEL = "料理";
// hydration（React がサーバー描画済み HTML に操作を結び付ける処理）の完了を待つ上限（ミリ秒）
const HYDRATION_TIMEOUT_MS = 15_000;

// アプリ画面の見出し。エラーバナーを探す範囲をアプリ自身の DOM に絞り込む目印に使う。
// Playwright のロケータは shadow DOM も貫通して探すため、範囲を絞らないと
// next dev が挿入する開発用オーバーレイ（<nextjs-portal> 内）の role="alert" まで
// 拾ってしまい、アプリはエラーを出していないのに撮影が失敗する。
const APP_HEADING = "AI 暮らしアシスタント";

// モック上流が実際に待ち受けているポート（listen 後に OS の割り当てを記録する）
let mockUpstreamPort = null;
// 起動中／起動済みの next dev プロセス（シグナルハンドラからも参照するため先に宣言する）
let appProcess = null;
// 録画の一時ディレクトリ（中断時にも消せるようここで保持する）
let videoDir = null;

// ログは stderr へ出す（生成物のパスなど結果は stdout と区別する）
const log = (msg) => process.stderr.write(`[capture-demo] ${msg}\n`);

// 指定ミリ秒待つユーティリティ
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows かどうか（プロセスの止め方が POSIX と異なるため、この 1 か所で判定して分岐を閉じ込める）
const IS_WINDOWS = process.platform === "win32";

/**
 * 子プロセスを、それが起動した孫プロセスもろとも終了させる。
 * next dev はビルドワーカーを子に持つため、親だけ殺すと孫がポートを掴んだまま残る。
 * 止め方が OS で異なるので、プラットフォーム差はここだけに閉じ込める（CLAUDE.md §10）。
 * @param {import("node:child_process").ChildProcess} child - 終了させる子プロセス
 * @param {NodeJS.Signals} signal - POSIX で送るシグナル（Windows では無視される）
 */
function killProcessTree(child, signal) {
  // Windows にはプロセスグループへのシグナル送出が無いため、taskkill でツリーごと終了させる
  if (IS_WINDOWS) {
    // /T は子孫まで、/F は強制終了を意味する
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // POSIX では負の PID でプロセスグループ全体へシグナルを送る
  process.kill(-child.pid, signal);
}

/**
 * fetch のレスポンス本文を破棄して接続をコネクションプールへ返す。
 * 本文を読まずに放置すると undici がソケットを掴んだままになるため（§8 リソース解放）。
 * @param {Response} res - 破棄する fetch レスポンス
 */
async function discardBody(res) {
  // 本文が無い応答（204 等）もあるのでオプショナルチェーンで扱い、キャンセル失敗は無視してよい
  await res.body?.cancel().catch(() => {});
}

/**
 * Anthropic Messages API のストリーミング応答（SSE）を模倣するモックサーバーを起動する。
 * @returns {Promise<{ server: http.Server, stats: { messagesRequests: number } }>}
 *   待受を開始したサーバーと、受け取ったリクエスト数のカウンタ
 */
function startMockUpstream() {
  // モックが実際に呼ばれたかを後から検証するためのカウンタ（課金呼び出し防止の要）
  const stats = { messagesRequests: 0 };

  // SSE イベントを 1 つ書き出すヘルパー（event 行 + data 行 + 空行）
  const writeEvent = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

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
    for (let i = 0; i < DEMO_ANSWER.length; i += DELTA_CHUNK_SIZE) {
      // 途中で相手が切断したら、破棄済みレスポンスへ書き続けず即座に抜ける
      if (clientGone) return;
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: DEMO_ANSWER.slice(i, i + DELTA_CHUNK_SIZE) },
      });
      // 次のチャンクまで少し待つ（体感に近いストリーミング速度にする）
      await sleep(DELTA_INTERVAL_MS);
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

  // 指定ポートで待受を開始し、開始完了を Promise で返す
  // （ポート使用中などの listen 失敗は 'error' イベントで拒否し、未捕捉例外にしない）
  return new Promise((resolve, reject) => {
    // listen 失敗を Promise の失敗として伝えるハンドラ
    const onListenError = (err) => reject(err);
    server.once("error", onListenError);
    server.listen(MOCK_UPSTREAM_PORT, "127.0.0.1", () => {
      // OS が実際に割り当てたポート番号を控える（アプリへ渡す接続先に使う）
      mockUpstreamPort = server.address().port;
      // listen 成功後はこのハンドラを外す。付けたままだと解決済み Promise に対する
      // reject になり、以降のサーバーエラーが何の痕跡も残さず消えてしまう（§6）
      server.off("error", onListenError);
      // 以降のエラーは握り潰さずログに残す
      server.on("error", (err) => log(`warning: モック上流でエラーが発生しました: ${err.message}`));
      resolve({ server, stats });
    });
  });
}

/**
 * 指定ポートが誰かに使われているかを調べる。
 * HTTP で叩いて判定すると、応答しない／HTTP ではない居座りプロセスを「空き」と誤判定し、
 * 起動待ちの上限時間まで無駄に待ったうえで的外れなエラーになる。実際に bind できるかで判定する。
 * @param {number} port - 調べる待受ポート
 * @returns {Promise<boolean>} 使用中なら true（bind できない場合も安全側に倒して true）
 */
async function isPortInUse(port) {
  // IPv4 ループバックを調べる
  if (await probePort(port, "127.0.0.1")) return true;
  // IPv6 ループバックも調べる。APP_URL は localhost なので、環境によっては ::1 側へ
  // 解決される。IPv4 だけ見ていると、::1 だけを掴んでいる別サーバーを「空き」と誤判定し、
  // 起動した自分のサーバーではなくそちらを録画してしまう
  return await probePort(port, "::1");
}

/**
 * 指定のホスト・ポートに bind できるかを試す。
 * @param {number} port - 調べる待受ポート
 * @param {string} host - 調べる待受アドレス
 * @returns {Promise<boolean>} 既に使われていれば true
 */
function probePort(port, host) {
  return new Promise((resolve) => {
    // 実際に bind を試すための使い捨てサーバーを作る
    const probe = net.createServer();
    probe.once("error", (err) => {
      // 使用中・権限不足は「使えない」ので使用中として扱う（安全側）。
      // IPv6 が無効な環境では ::1 が EAFNOSUPPORT / EADDRNOTAVAIL になるが、
      // これは「誰も使っていない」ので false を返す（誤検知で起動を止めない）
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES");
    });
    // bind できたら空きなので、すぐ閉じて false を返す
    probe.once("listening", () => probe.close(() => resolve(false)));
    // 対象のアドレスへ bind を試す
    probe.listen(port, host);
  });
}

/**
 * Next.js 開発サーバーをモック上流に向けて起動し、応答可能になるまで待つ。
 * @returns {Promise<import("node:child_process").ChildProcess>} 起動したプロセス
 */
async function startAppServer() {
  // ポートが既に使われている場合は起動前に中断する。
  // 「200 が返るか」だけのヘルスチェックだと、別プロセスのサーバー（実 API キー向きの
  // 可能性がある）を自分のサーバーと誤認して録画してしまうため、fail-closed にする。
  if (await isPortInUse(APP_PORT)) {
    throw new Error(
      `ポート ${APP_PORT} が既に使用されています。既存の next dev 等を停止してから再実行してください。`,
    );
  }
  // next 本体を node で直接起動する。npx 経由だとラッパープロセスに SIGTERM を送っても
  // 実サーバーが孤児化して生き残るため、detached でプロセスグループを作り、
  // 終了時はグループごとシグナルを送れるようにする。
  const nextBin = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "--port", String(APP_PORT)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // ダミーの API キー（モック上流しか呼ばないので実キーは不要）
      ANTHROPIC_API_KEY: "demo-dummy-key",
      // Anthropic SDK の接続先をローカルのモックへ差し替える（実際に割り当てられたポート）
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockUpstreamPort}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
    // POSIX では自分のプロセスグループを作らせる（後始末でグループごと kill するため）。
    // Windows には同等の概念が無く、detached はコンソール分離の意味になってしまうので付けない
    detached: !IS_WINDOWS,
  });
  // spawn の失敗は例外ではなく 'error' イベントで通知される。listener が無いと
  // 未捕捉例外になり、後始末（finally）を飛ばして一時ファイルとサーバーが残る
  let spawnError = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  // 起動待ちの間に Ctrl-C されても確実に kill できるよう、spawn 直後に控える。
  // 戻り値の代入（appProcess = await startAppServer()）を待つと、最大 120 秒の
  // 起動待ちの間だけシグナルハンドラが子プロセスを知らず、孤児化してポートを掴み続ける
  appProcess = child;
  // 子プロセスが先に死んだらポーリングを打ち切るためのフラグ
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  // ヘルスチェックで最後に観測したエラー（タイムアウト時の原因説明に使う）
  let lastHealthCheckError = null;
  // サーバーが応答するまで既定の上限時間までポーリングする
  const deadline = Date.now() + APP_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // spawn 自体に失敗した場合（実行ファイルが無い・プロセス数上限など）は原因を添えて失敗させる
    if (spawnError) {
      throw new Error(`next dev を起動できませんでした: ${spawnError.message}`, { cause: spawnError });
    }
    // 子プロセスが即死した場合は上限まで待たずに原因つきで失敗させる
    if (exited) {
      throw new Error(`next dev が起動前に終了しました (exit code: ${exitCode})。上のログを確認してください。`);
    }
    try {
      // トップページの応答が返れば起動完了とみなす
      const res = await fetch(APP_URL);
      // 応答本文を破棄してソケットを解放する（読み捨てないと接続が滞留する）
      await discardBody(res);
      if (res.ok) return child;
    } catch (err) {
      // 起動途中の接続拒否は想定内だが、名前解決やプロキシ設定の誤りなど
      // 再試行しても直らない失敗もここに来る。原因を捨てるとタイムアウト時に
      // 「アプリが起動しなかった」としか分からなくなるので、最後のエラーを控えておく
      lastHealthCheckError = err;
    }
    // 1 秒待って再試行する
    await sleep(1000);
  }
  // 起動しなかった場合は失敗させる（fail-closed）。最後に観測したエラーを添えて原因を追えるようにする
  await stopAppServer(child);
  const reason = lastHealthCheckError ? `（最後のエラー: ${lastHealthCheckError.message}）` : "";
  throw new Error(`アプリが ${APP_URL} で起動しませんでした${reason}`, {
    cause: lastHealthCheckError ?? undefined,
  });
}

/**
 * アプリのプロセスグループ全体を終了させ、実際に終わるまで待つ。
 * 待たずに次の後始末へ進むと、next dev が掴んだままの接続でモック上流の close() が
 * 完了せず、スクリプトが終了できなくなる。
 * @param {import("node:child_process").ChildProcess} child - startAppServer が返したプロセス
 */
async function stopAppServer(child) {
  // 既に終了しているなら何もしない（終了済みプロセスの exit を待つと永久に待つため）
  if (child.exitCode !== null || child.signalCode !== null) return;
  // spawn 自体に失敗していると PID が無い。この場合 'exit' は永遠に来ないので、
  // 待ちに入る前に抜ける（Windows の taskkill は失敗しても例外を投げないため、
  // 下の catch では取りこぼしてハングしてしまう）
  if (!child.pid) return;
  // 終了イベントを待つ Promise を、シグナル送出より先に用意する（取りこぼし防止）
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    // プロセスツリー全体を終了させる（OS 差は killProcessTree 内に閉じ込めてある）
    killProcessTree(child, "SIGTERM");
  } catch {
    // 既に終了している場合はそのままでよい（後始末なので失敗を無視してよい唯一の箇所）
    return;
  }
  // SIGTERM を無視して居座る場合に備え、猶予後に強制終了する保険をかける
  const killTimer = setTimeout(() => {
    try {
      killProcessTree(child, "SIGKILL");
    } catch {
      // 強制終了の時点で既に消えていれば何もしなくてよい
    }
  }, APP_SHUTDOWN_GRACE_MS);
  // 実際に終了するまで待つ
  await exited;
  // 保険のタイマーを解除する（残すとイベントループが終わらない）
  clearTimeout(killTimer);
}

/**
 * 要素の aria-pressed が "true" になるまで待つ（hydration 完了とクリック反映の確認）。
 * @param {import("@playwright/test").Locator} locator - トグルボタンのロケータ
 */
async function clickUntilPressed(locator) {
  // 一定時間、クリックと確認を繰り返す
  const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // クリックする。hydration 前ならリスナーが無く黙って捨てられるので、後で再試行する
    await locator.click();
    // 反映を少し待ってから押下状態を確認する
    await sleep(300);
    // aria-pressed が true になっていれば React に届いた証拠なので抜ける
    if ((await locator.getAttribute("aria-pressed")) === "true") return;
  }
  // 期限内に押下状態にならなければ hydration 未完了とみなして失敗させる（fail-closed）
  throw new Error(
    "カテゴリチップの選択が反映されませんでした（hydration 未完了の可能性）。撮影を中止します。",
  );
}

/**
 * 要素が操作可能（enabled）になるまで待つ。
 * @param {import("@playwright/test").Locator} locator - 対象のロケータ
 * @param {string} description - 失敗時のメッセージに載せる対象の説明
 */
async function waitForEnabled(locator, description) {
  // 一定時間ポーリングし、操作可能になったら抜ける
  const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 現在の操作可否を確認する
    if (await locator.isEnabled()) return;
    // まだなら少し待って再確認する
    await sleep(200);
  }
  // 操作可能にならないまま進むとクリックが 30 秒タイムアウトして原因が分かりにくいので中止する
  throw new Error(`${description}が操作可能になりませんでした。撮影を中止します。`);
}

/**
 * Playwright で「カテゴリ選択 → 質問入力 → ストリーミング回答」を録画する。
 * @returns {Promise<string>} 録画された webm ファイルのパス
 */
async function recordDemoVideo() {
  // 録画の一時出力ディレクトリを OS の一時領域に作る（移植性のため /tmp 直書きを避ける）。
  // 中断時にも消せるようモジュール変数へ入れる
  videoDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-demo-video-"));
  // 後始末は下の finally 1 か所に集約する。ブラウザ起動・コンテキスト生成・操作の
  // どこで失敗しても、同じ経路でブラウザを閉じ一時ディレクトリを消せるようにするため
  // （散らばらせると、後から片付け処理を足したときに漏れが出る）
  let browser = null;
  let context = null;
  // 録画ファイルを確定できたかどうか（成功時は一時ディレクトリを呼び出し側で使うため消さない）
  let succeeded = false;
  try {
    // Chromium を起動する（実行ファイルの差し替え判定は E2E 設定と共有のヘルパーに任せる）
    browser = await chromium.launch(chromiumLaunchOptions());
    // 録画つきのブラウザコンテキストを作る
    context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    {
      // 新しいページを開く
      const page = await context.newPage();
      // アプリのトップページへ移動する
      await page.goto(APP_URL);
      // next dev が挿入する開発ツールのバッジ（画面左下の丸い「N」）を隠す。
      // 撮影は dev サーバーに対して行うため、そのままだと README の代表画像に
      // 開発時にしか出ない UI が焼き込まれてしまう。
      // style は文書に紐づくので、goto で読み込んだ後に入れる必要がある
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      // 初期画面（カテゴリチップ）が見えるまで待ち、少し静止させる
      const cookingChip = page.getByRole("button", { name: DEMO_CATEGORY_LABEL });
      await cookingChip.waitFor();
      await sleep(1200);
      // 「料理」カテゴリのチップを、選択が React に届くまで再試行しながらクリックする。
      // hydration 前のクリックはリスナーが未装着で黙って捨てられるため、1 回で諦めると
      // カテゴリ未選択（なんでも）のまま撮影が続き、README の説明と食い違う GIF ができる。
      // ここを通過した時点で hydration は完了しているので、以降の入力は React に届く
      await clickUntilPressed(cookingChip);
      await sleep(800);
      // 入力欄に質問をタイプする（タイピングの様子を見せるため 1 文字ずつ入力する）
      const input = page.getByLabel("メッセージを入力");
      await input.pressSequentially(DEMO_QUESTION, { delay: 35 });
      // 送信ボタンは disabled={isLoading || !input.trim()} なので、有効化されたことが
      // 「入力が React の state に入った」唯一の確かな証拠になる（DOM の value は
      // hydration 前のタイプでも埋まってしまい、判定に使えない）
      const sendButton = page.getByRole("button", { name: "送信" });
      await waitForEnabled(sendButton, "送信ボタン");
      await sleep(500);
      // 送信ボタンをクリックする
      await sendButton.click();
      // ストリーミング回答が完了するまで待つ（送信ボタンが「送信中...」から戻るのを待つ）
      await page.getByRole("button", { name: "送信", exact: true }).waitFor({ timeout: 60_000 });
      // 回答全文を読める静止時間をとる（録画末尾の切り落とし分の余白も兼ねる）
      await sleep(ANSWER_SETTLE_MS);

      // ここから撮れ高の検証。送信ボタンはエラー時にも「送信」へ戻るため、
      // ボタンの状態だけを根拠にすると、エラー画面の GIF を「成功」として
      // 上書きしてしまう。回答が出ていること・エラーが出ていないことを明示的に確かめる。
      // 探索範囲をアプリ本体の DOM に限定する（見出しを含む body 直下の要素を目印にする）
      const appRoot = page
        .locator("body > div")
        .filter({ has: page.getByRole("heading", { name: APP_HEADING }) });
      // 目印が見つからないと以降の検査が「0 件だから合格」と素通りしてしまうため、
      // まず範囲そのものを確認する（レイアウト変更で検査が無効化されるのを防ぐ fail-closed）
      if ((await appRoot.count()) !== 1) {
        throw new Error(
          "アプリのルート要素を特定できませんでした（レイアウト変更の可能性）。検査できないため撮影を中止します。",
        );
      }
      // アプリのエラーバナー（role="alert"）が出ていないことを確認する
      const errorBanner = appRoot.getByRole("alert");
      if ((await errorBanner.count()) > 0) {
        // エラー文言を添えて失敗させる（原因調査のため）
        const alertText = await errorBanner.first().innerText();
        throw new Error(`撮影中にエラーが表示されました: ${alertText}`);
      }
      // 回答の末尾が描画されている＝ストリーミングが最後まで届いたことを確認する。
      // count() は複数一致でも例外にならないので、「出ていない」と「複数一致」を区別できる
      // （isVisible() の失敗をまとめて握り潰すと、目印の重複を配信切れと誤診断してしまう）
      const answerMarker = page.getByText(ANSWER_TAIL_MARKER);
      const markerCount = await answerMarker.count();
      if (markerCount === 0) {
        throw new Error("デモ回答が最後まで表示されませんでした（ストリーミングが途中で切れた可能性）");
      }
      if (markerCount > 1) {
        throw new Error(
          `回答末尾の目印「${ANSWER_TAIL_MARKER}」が ${markerCount} 件一致しました。目印が一意になるよう DEMO_ANSWER を見直してください。`,
        );
      }
      // 「表示されている」だけでなく、実際に録画範囲（ビューポート）へ収まっているかを見る。
      // 回答はスクロールする領域の中にあるため、isVisible() は画面外へスクロールしていても
      // true を返す。それだと途中までしか写っていない GIF を成功として通してしまう
      // 判定するのは「末尾の下端が画面内に収まっているか」だけにする。
      // getByText は回答全体を含む 1 つの <p> に解決されるため、上端まで条件に入れると、
      // 回答が長くなって上へスクロールしただけの正常な録画まで失敗扱いになってしまう
      const markerBox = await answerMarker.boundingBox();
      const markerBottom = markerBox === null ? null : markerBox.y + markerBox.height;
      const markerInViewport = markerBottom !== null && markerBottom > 0 && markerBottom <= VIEWPORT.height;
      if (!markerInViewport) {
        throw new Error(
          "デモ回答の末尾が録画範囲に収まっていません（スクロール位置の確認が必要）。撮影を中止します。",
        );
      }
      // 録画を確定させてパスを受け取る
      const recordedPath = await finishRecording(page, context);
      // ここまで来たら成果物が手に入っているので、一時ディレクトリは呼び出し側の後始末に任せる
      succeeded = true;
      return recordedPath;
    }
  } finally {
    // コンテキストを閉じる（成功時は finishRecording が既に閉じているが、二重呼び出しは無害）
    if (context) await context.close().catch(() => {});
    // 例外の有無にかかわらずブラウザを必ず閉じる（開いたままだとプロセスが終了しない）
    if (browser) await browser.close().catch(() => {});
    // 失敗した場合だけ、途中までの録画が入った一時ディレクトリをここで消す
    if (!succeeded && videoDir) {
      fs.rmSync(videoDir, { recursive: true, force: true });
      videoDir = null;
    }
  }
}

/**
 * 録画を確定させ、生成された webm ファイルのパスを返す。
 * @param {import("@playwright/test").Page} page - 録画対象のページ
 * @param {import("@playwright/test").BrowserContext} context - 録画中のコンテキスト
 * @returns {Promise<string>} 録画された webm ファイルのパス
 */
async function finishRecording(page, context) {
  // 録画中の動画ハンドルを、ページを閉じる前に取得しておく
  const video = page.video();
  // ページを先に閉じて録画を停止させる（コンテキストごと閉じるより末尾が落ちにくい）
  await page.close();
  // コンテキストを閉じて録画をフラッシュする（閉じるまでファイルは書き出されない）
  await context.close();
  // 動画ハンドルがあれば、書き出し済みのパスを直接受け取る（ディレクトリ走査より確実）
  if (video) return await video.path();
  // ハンドルが取れない場合に備え、出力ディレクトリから webm を探すフォールバックを残す
  const files = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (files.length === 0) throw new Error("録画ファイルが生成されませんでした");
  return path.join(videoDir, files[0]);
}

/**
 * webm 録画を GIF へ変換する（パレット最適化つき）。
 * @param {string} videoPath - 変換元の webm ファイル
 */
function convertToGif(videoPath) {
  // 出力先ディレクトリを保証する
  fs.mkdirSync(path.dirname(GIF_PATH), { recursive: true });
  try {
    // ffmpeg のパレット生成 + 適用を 1 コマンドで行う（10fps・幅 1000px に縮小して 10MB 以下を狙う）。
    // 書き出し先は一時ファイルにし、検査を通ってから本来のパスへ差し替える
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        videoPath,
        "-vf",
        "fps=10,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        GIF_TMP_PATH,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    // ffmpeg 自体を起動できなかった場合（未インストール等）は原因を添えて失敗させる。
    // このとき status は null なので、下の status 判定だけだと理由が失われる（§6）
    if (result.error) {
      throw new Error(
        `ffmpeg を起動できませんでした（インストールされていない可能性があります）: ${result.error.message}`,
        { cause: result.error },
      );
    }
    // 変換失敗は即座にエラーにする
    if (result.status !== 0) {
      throw new Error(`ffmpeg による GIF 変換に失敗しました (exit code: ${result.status})`);
    }
    // 生成された GIF のサイズを確認する
    const size = fs.statSync(GIF_TMP_PATH).size;
    // 10MB を超えていたら基準違反なので差し替えずに失敗させる（CLAUDE.md §15 / fail-closed）。
    // 警告だけにすると、基準外の GIF がそのままコミットできる状態で残ってしまう
    if (size > GIF_MAX_BYTES) {
      throw new Error(
        `GIF が上限 ${GIF_MAX_BYTES / 1024 / 1024}MB を超えました (${(size / 1024 / 1024).toFixed(2)} MB)。fps や幅を下げて再生成してください。`,
      );
    }
    // すべての検査を通ったのでコミット対象のパスへ差し替える（同一ディレクトリなので原子的に入れ替わる）
    fs.renameSync(GIF_TMP_PATH, GIF_PATH);
    log(`GIF を生成しました: ${GIF_PATH} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  } finally {
    // 失敗して残った一時ファイルを片付ける（成功時は rename 済みなので何も残らない）。
    // これにより、失敗しても既存のコミット済み GIF は一切損なわれない
    fs.rmSync(GIF_TMP_PATH, { force: true });
  }
}

// ---- メイン処理 ----
// モック上流 → アプリ → 録画 → GIF 変換の順に実行し、後始末を必ず行う
const { server: mockServer, stats: mockStats } = await startMockUpstream();
log(`モック上流を起動しました (port ${mockUpstreamPort})`);
let videoPath = null;

// Ctrl-C などで中断されたときの後始末。detached で起動した next dev は自分の
// プロセスグループにいるため Ctrl-C が届かず、ハンドラを置かないとポートを掴んだまま
// 孤児として残り、次回の実行が「ポート使用中」で失敗し続ける。
// シグナルハンドラ内では await できないので、確実に止まる SIGKILL を同期的に送る。
// process.exit() は下の finally を実行しないため、一時ファイルもここで消す。
const cleanUpOnSignal = (signal) => {
  log(`${signal} を受け取りました。後始末して終了します。`);
  if (appProcess) {
    try {
      // プロセスツリーごと強制終了する（孤児化を防ぐ）
      killProcessTree(appProcess, "SIGKILL");
    } catch {
      // 既に終了していれば何もしなくてよい
    }
  }
  // 録画の一時ディレクトリ（数 MB の webm）を消す
  if (videoDir) fs.rmSync(videoDir, { recursive: true, force: true });
  // 変換途中の一時 GIF を消す（コミット対象のディレクトリに置くため放置しない）
  fs.rmSync(GIF_TMP_PATH, { force: true });
  // モック上流の接続を切って閉じる
  mockServer.closeAllConnections();
  mockServer.close();
  // 中断による終了であることを終了コードで示す（128 + シグナル番号の慣例）
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.once("SIGINT", () => cleanUpOnSignal("SIGINT"));
process.once("SIGTERM", () => cleanUpOnSignal("SIGTERM"));

try {
  // appProcess は startAppServer が spawn 直後に自分で設定する（起動待ち中の中断に備えるため）
  await startAppServer();
  log(`アプリを起動しました (${APP_URL})`);
  videoPath = await recordDemoVideo();
  log(`録画が完了しました: ${videoPath}`);
  // モックが一度も呼ばれていなければ、アプリは実 Claude API を叩いた可能性がある
  // （例: .env.local が ANTHROPIC_BASE_URL を上書きした）。このスクリプトの存在意義は
  // 「課金呼び出しをしないこと」なので、確認できない限り成果物を作らない（fail-closed）
  if (mockStats.messagesRequests === 0) {
    throw new Error(
      "モック上流が一度も呼ばれませんでした。ANTHROPIC_BASE_URL が .env.local 等で上書きされ、" +
        "実 Claude API を呼んだ可能性があります（課金の恐れ）。設定を確認してください。",
    );
  }
  log(`モック上流へのリクエスト数: ${mockStats.messagesRequests}`);
  convertToGif(videoPath);
} finally {
  // アプリのプロセスグループを終了し、実際に終わるまで待つ
  if (appProcess) await stopAppServer(appProcess);
  // 録画の一時ディレクトリ（数 MB の webm）を削除する
  if (videoDir) fs.rmSync(videoDir, { recursive: true, force: true });
  // 残っている keep-alive 接続を切ってから閉じる（close() だけだと接続が残る限り完了しない）
  mockServer.closeAllConnections();
  mockServer.close();
}
