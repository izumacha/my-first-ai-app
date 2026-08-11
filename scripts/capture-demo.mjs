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
 *       既存の Chromium 実行ファイルを指定できる（playwright.config.ts と同じ逃げ道）。
 * 生成物: docs/screenshots/chat-demo.gif
 */

// Node 標準の HTTP サーバー（モック上流用）を読み込む
import http from "node:http";
// 子プロセス起動（next dev / ffmpeg 実行用）を読み込む
import { spawn, spawnSync } from "node:child_process";
// ファイル操作（GIF サイズ確認・一時ファイル削除用）を読み込む
import fs from "node:fs";
// パス結合ユーティリティを読み込む
import path from "node:path";
// Playwright の chromium ランチャーを読み込む（録画機能つきブラウザ操作）
import { chromium } from "@playwright/test";

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
// GIF の上限サイズ（CLAUDE.md §15: 10MB 以下）
const GIF_MAX_BYTES = 10 * 1024 * 1024;
// 生成物の出力先
const GIF_PATH = path.join("docs", "screenshots", "chat-demo.gif");

// デモで入力する質問文（ダミー。個人情報を含めない）
const DEMO_QUESTION =
  "冷蔵庫に卵とキャベツが残っています。簡単に作れる夕食のレシピを教えてください。";

// モックが返すデモ回答（スタブであることが撮影上わからないよう、実際の回答らしい文面にする）
const DEMO_ANSWER = [
  "卵とキャベツがあれば「とん平焼き風オムレツ」がおすすめです！",
  "",
  "**材料（1人分）**",
  "- 卵 2個 / キャベツ 1/8玉 / 塩こしょう 少々",
  "- お好みでソース・マヨネーズ・かつお節",
  "",
  "**作り方（約10分）**",
  "1. キャベツを千切りにして耐熱容器で1分半レンジ加熱",
  "2. フライパンで溶き卵を半熟に焼き、キャベツをのせて包む",
  "3. ソースとマヨネーズをかけて完成！",
  "",
  "キャベツの甘みと半熟卵がよく合いますよ。ごはんにもパンにも合うので、ぜひ試してみてください🍳",
].join("\n");

// ログは stderr へ出す（生成物のパスなど結果は stdout と区別する）
const log = (msg) => process.stderr.write(`[capture-demo] ${msg}\n`);

// 指定ミリ秒待つユーティリティ
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Anthropic Messages API のストリーミング応答（SSE）を模倣するモックサーバーを起動する。
 * @returns {Promise<http.Server>} 待受を開始したサーバー
 */
function startMockUpstream() {
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
    // リクエスト本文は読み捨てる（内容によらず固定のデモ回答を返す）
    req.resume();
    // 本文の読み終わりを待つ
    await new Promise((resolve) => req.once("end", resolve));
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
    const CHUNK_SIZE = 6;
    for (let i = 0; i < DEMO_ANSWER.length; i += CHUNK_SIZE) {
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: DEMO_ANSWER.slice(i, i + CHUNK_SIZE) },
      });
      // 次のチャンクまで少し待つ（体感に近いストリーミング速度にする）
      await sleep(DELTA_INTERVAL_MS);
    }
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
  return new Promise((resolve) => {
    server.listen(MOCK_UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Next.js 開発サーバーをモック上流に向けて起動し、応答可能になるまで待つ。
 * @returns {Promise<import("node:child_process").ChildProcess>} 起動したプロセス
 */
async function startAppServer() {
  // next dev をデモ用の環境変数つきで起動する
  const child = spawn("npx", ["next", "dev", "--port", String(APP_PORT)], {
    env: {
      ...process.env,
      // ダミーの API キー（モック上流しか呼ばないので実キーは不要）
      ANTHROPIC_API_KEY: "demo-dummy-key",
      // Anthropic SDK の接続先をローカルのモックへ差し替える
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  // サーバーが応答するまで最大 120 秒ポーリングする
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      // トップページの応答が返れば起動完了とみなす
      const res = await fetch(APP_URL);
      if (res.ok) return child;
    } catch {
      // まだ起動していないだけなので握り潰さず次のループで再試行する
    }
    // 1 秒待って再試行する
    await sleep(1000);
  }
  // 起動しなかった場合は失敗させる（fail-closed）
  child.kill("SIGTERM");
  throw new Error(`アプリが ${APP_URL} で起動しませんでした`);
}

/**
 * Playwright で「カテゴリ選択 → 質問入力 → ストリーミング回答」を録画する。
 * @returns {Promise<string>} 録画された webm ファイルのパス
 */
async function recordDemoVideo() {
  // 録画の一時出力ディレクトリを作る
  const videoDir = fs.mkdtempSync(path.join("/tmp", "chat-demo-video-"));
  // Chromium を起動する（環境変数があれば実行ファイルを差し替える。playwright.config.ts と同じ）
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  // 録画つきのブラウザコンテキストを作る
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
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
  // 回答全文を読める静止時間をとる
  await sleep(2500);
  // コンテキストを閉じて録画をフラッシュする
  await context.close();
  await browser.close();
  // 生成された webm ファイル（1 つだけのはず）を探して返す
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
  // 変換失敗は即座にエラーにする
  if (result.status !== 0) throw new Error("ffmpeg による GIF 変換に失敗しました");
  // 生成された GIF のサイズを確認する
  const size = fs.statSync(GIF_PATH).size;
  log(`GIF を生成しました: ${GIF_PATH} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  // 10MB を超えていたら警告する（CLAUDE.md §15 の基準）
  if (size > GIF_MAX_BYTES) {
    log("warning: GIF が 10MB を超えています。fps や幅を下げて再生成してください。");
  }
}

// ---- メイン処理 ----
// モック上流 → アプリ → 録画 → GIF 変換の順に実行し、後始末を必ず行う
const mockServer = await startMockUpstream();
log(`モック上流を起動しました (port ${MOCK_UPSTREAM_PORT})`);
let appProcess = null;
try {
  appProcess = await startAppServer();
  log(`アプリを起動しました (${APP_URL})`);
  const videoPath = await recordDemoVideo();
  log(`録画が完了しました: ${videoPath}`);
  convertToGif(videoPath);
} finally {
  // アプリのプロセスを終了する
  if (appProcess) appProcess.kill("SIGTERM");
  // モック上流を閉じる
  mockServer.close();
}
