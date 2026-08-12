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
// モック上流サーバーの待受ポート
const MOCK_UPSTREAM_PORT = 43111;
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

// デモで入力する質問文（ダミー。個人情報を含めない）
const DEMO_QUESTION =
  "冷蔵庫に卵とキャベツが残っています。簡単に作れる夕食のレシピを教えてください。";

// モックが返すデモ回答（スタブであることが撮影上わからないよう、実際の回答らしい文面にする）。
// ChatMessage は本文を Markdown ではなくプレーンテキストとして描画する（whitespace-pre-wrap）ため、
// `**強調**` を書くと GIF にアスタリスクがそのまま写ってしまう。見出しは記号で表現する。
const DEMO_ANSWER = [
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
  "キャベツの甘みと半熟卵がよく合いますよ。ごはんにもパンにも合うので、ぜひ試してみてください🍳",
].join("\n");

// 回答が最後まで描画されたことを確認するための目印（DEMO_ANSWER 末尾の一節）。
// これが画面に出ていれば、ストリーミングが途中で切れていないと判断できる。
const ANSWER_TAIL_MARKER = "ぜひ試してみてください";

// アプリ画面の見出し。エラーバナーを探す範囲をアプリ自身の DOM に絞り込む目印に使う。
// Playwright のロケータは shadow DOM も貫通して探すため、範囲を絞らないと
// next dev が挿入する開発用オーバーレイ（<nextjs-portal> 内）の role="alert" まで
// 拾ってしまい、アプリはエラーを出していないのに撮影が失敗する。
const APP_HEADING = "AI 暮らしアシスタント";

// ログは stderr へ出す（生成物のパスなど結果は stdout と区別する）
const log = (msg) => process.stderr.write(`[capture-demo] ${msg}\n`);

// 指定ミリ秒待つユーティリティ
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Next.js 開発サーバーをモック上流に向けて起動し、応答可能になるまで待つ。
 * @returns {Promise<import("node:child_process").ChildProcess>} 起動したプロセス
 */
async function startAppServer() {
  // ポートが既に使われている場合は起動前に中断する。
  // 「200 が返るか」だけのヘルスチェックだと、別プロセスのサーバー（実 API キー向きの
  // 可能性がある）を自分のサーバーと誤認して録画してしまうため、fail-closed にする。
  const portInUse = await fetch(APP_URL).then(
    async (res) => {
      // 応答本文を破棄してソケットを解放する
      await discardBody(res);
      return true;
    },
    () => false,
  );
  if (portInUse) {
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
      // Anthropic SDK の接続先をローカルのモックへ差し替える
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
    // 自分のプロセスグループを作らせる（後始末でグループごと kill するため）
    detached: true,
  });
  // 子プロセスが先に死んだらポーリングを打ち切るためのフラグ
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  // サーバーが応答するまで既定の上限時間までポーリングする
  const deadline = Date.now() + APP_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
    } catch {
      // まだ起動していないだけなので握り潰さず次のループで再試行する
    }
    // 1 秒待って再試行する
    await sleep(1000);
  }
  // 起動しなかった場合は失敗させる（fail-closed）
  await stopAppServer(child);
  throw new Error(`アプリが ${APP_URL} で起動しませんでした`);
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
  // 終了イベントを待つ Promise を、シグナル送出より先に用意する（取りこぼし防止）
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    // 負の PID を指定するとプロセスグループ全体へシグナルが送られる
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 既に終了している場合はそのままでよい（後始末なので失敗を無視してよい唯一の箇所）
    return;
  }
  // SIGTERM を無視して居座る場合に備え、猶予後に強制終了する保険をかける
  const killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
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
 * Playwright で「カテゴリ選択 → 質問入力 → ストリーミング回答」を録画する。
 * @returns {Promise<string>} 録画された webm ファイルのパス
 */
async function recordDemoVideo() {
  // 録画の一時出力ディレクトリを OS の一時領域に作る（移植性のため /tmp 直書きを避ける）
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-demo-video-"));
  // Chromium を起動する（実行ファイルの差し替え判定は E2E 設定と共有のヘルパーに任せる）
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    // 録画つきのブラウザコンテキストを作る
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    try {
      // 新しいページを開く
      const page = await context.newPage();
      // アプリのトップページへ移動する
      await page.goto(APP_URL);
      // 初期画面（カテゴリチップ）が見えるまで待ち、少し静止させる
      await page.getByRole("button", { name: "料理" }).waitFor();
      await sleep(1200);
      // 「料理」カテゴリのチップをクリックする
      await page.getByRole("button", { name: "料理" }).click();
      await sleep(800);
      // 入力欄に質問をタイプする（タイピングの様子を見せるため 1 文字ずつ入力する）
      await page.getByLabel("メッセージを入力").pressSequentially(DEMO_QUESTION, { delay: 35 });
      await sleep(500);
      // 送信ボタンをクリックする
      await page.getByRole("button", { name: "送信" }).click();
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
      // アプリのエラーバナー（role="alert"）が出ていないことを確認する
      const errorBanner = appRoot.getByRole("alert");
      if ((await errorBanner.count()) > 0) {
        // エラー文言を添えて失敗させる（原因調査のため）
        const alertText = await errorBanner.first().innerText();
        throw new Error(`撮影中にエラーが表示されました: ${alertText}`);
      }
      // 回答の末尾が描画されている＝ストリーミングが最後まで届いたことを確認する
      const answerRendered = await page
        .getByText(ANSWER_TAIL_MARKER)
        .isVisible()
        .catch(() => false);
      if (!answerRendered) {
        throw new Error("デモ回答が最後まで表示されませんでした（ストリーミングが途中で切れた可能性）");
      }
      return await finishRecording(page, context, videoDir);
    } catch (err) {
      // 失敗時もコンテキストを閉じ、途中までの録画一時ディレクトリを残さない
      await context.close().catch(() => {});
      fs.rmSync(videoDir, { recursive: true, force: true });
      throw err;
    }
  } finally {
    // 例外の有無にかかわらずブラウザを必ず閉じる（開いたままだとプロセスが終了しない）
    await browser.close().catch(() => {});
  }
}

/**
 * 録画を確定させ、生成された webm ファイルのパスを返す。
 * @param {import("@playwright/test").Page} page - 録画対象のページ
 * @param {import("@playwright/test").BrowserContext} context - 録画中のコンテキスト
 * @param {string} videoDir - 録画の出力先ディレクトリ
 * @returns {Promise<string>} 録画された webm ファイルのパス
 */
async function finishRecording(page, context, videoDir) {
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
  // ffmpeg のパレット生成 + 適用を 1 コマンドで行う（10fps・幅 1000px に縮小して 10MB 以下を狙う）
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      "fps=10,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      GIF_PATH,
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
  const size = fs.statSync(GIF_PATH).size;
  // 10MB を超えていたら基準違反なので、生成物を残さず失敗させる（CLAUDE.md §15 / fail-closed）。
  // 警告だけにすると、基準外の GIF がそのままコミットできる状態で残ってしまう
  if (size > GIF_MAX_BYTES) {
    fs.rmSync(GIF_PATH, { force: true });
    throw new Error(
      `GIF が上限 ${GIF_MAX_BYTES / 1024 / 1024}MB を超えました (${(size / 1024 / 1024).toFixed(2)} MB)。fps や幅を下げて再生成してください。`,
    );
  }
  log(`GIF を生成しました: ${GIF_PATH} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

// ---- メイン処理 ----
// モック上流 → アプリ → 録画 → GIF 変換の順に実行し、後始末を必ず行う
const { server: mockServer, stats: mockStats } = await startMockUpstream();
log(`モック上流を起動しました (port ${MOCK_UPSTREAM_PORT})`);
let appProcess = null;
let videoPath = null;
try {
  appProcess = await startAppServer();
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
  if (videoPath) fs.rmSync(path.dirname(videoPath), { recursive: true, force: true });
  // 残っている keep-alive 接続を切ってから閉じる（close() だけだと接続が残る限り完了しない）
  mockServer.closeAllConnections();
  mockServer.close();
}
