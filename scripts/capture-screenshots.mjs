/**
 * README 掲載用スクリーンショット 4 枚の自動撮影スクリプト（上流 Claude API はスタブ）
 *
 * CLAUDE.md §3「見せ方」に挙げた 4 枚（初期画面 / カテゴリ選択 + 質問入力 /
 * エラー表示 / モバイル表示）を、手作業ではなく毎回同じ手順で撮り直せるようにする。
 * 実 API キーでの課金呼び出しを避けるため、デモ GIF 撮影と同じモック上流を立てて
 * `ANTHROPIC_BASE_URL` でアプリをそこへ向ける（アプリ本体のコードは変更しない）。
 *
 * 実行: node scripts/capture-screenshots.mjs
 * 依存: @playwright/test（同梱の chromium）。ffmpeg は不要（静止画のみ）。
 *       `npx playwright install` できない環境では PLAYWRIGHT_CHROMIUM_PATH で
 *       既存の Chromium 実行ファイルを指定できる（scripts/lib/chromium-launch-options.mjs）。
 * 生成物: docs/screenshots/ 配下の PNG 4 枚（下の SHOTS が唯一の一覧）
 *
 * エラー表示の撮影方法について: 画面に出すのはアプリ自身のレート制限（1 分 20 リクエスト）の
 * 応答で、上流 Claude API は一切呼ばない。ページ内から /api/chat を 429 が返るまで叩いて
 * 枠を使い切り、そのうえで UI から送信することで、実運用と同じ経路の 429 を表示させる。
 * 上限値（20）はアプリ側の定数なのでここには書き写さず、「429 が返るまで」で判定する
 * （書き写すと、アプリ側で上限を変えたときにこのスクリプトだけ古いまま壊れる）。
 *
 * 失敗時は必ず throw して既存の PNG を書き換えないこと（fail-closed）。README が参照する
 * 資産なので、hydration 前の空画面やエラー状態の画像を「成功」として上書きすると、
 * 実物と食い違うスクショがそのままコミットされてしまう。4 枚すべての検査を通ってから
 * まとめて差し替えるので、途中で失敗しても「新旧が混ざった状態」は残らない。
 */

// ファイル操作（一時ディレクトリの作成・生成物の差し替え）を読み込む
import fs from "node:fs";
// OS 情報（一時ディレクトリの場所）を読み込む
import os from "node:os";
// パス結合ユーティリティを読み込む
import path from "node:path";
// file:// URL をファイルパスへ変換するユーティリティを読み込む
import { fileURLToPath } from "node:url";
// Playwright の chromium ランチャーを読み込む
import { chromium } from "@playwright/test";
// ブラウザ起動オプションの組み立て（E2E 設定・デモ GIF 撮影と共有）
import { chromiumLaunchOptions } from "./lib/chromium-launch-options.mjs";
// アプリサーバーの起動・停止まわり（デモ GIF 撮影と共有）
import {
  createLogger,
  killProcessTree,
  sleep,
  startAppServer,
  stopAppServer,
} from "./lib/app-server.mjs";
// 上流 Claude API を模倣するモックサーバー（デモ GIF 撮影と共有）
import { startMockUpstream } from "./lib/mock-upstream.mjs";
// 撮影で使う質問・回答・画面上の目印（デモ GIF 撮影と共有）
import {
  APP_HEADING,
  DEMO_ANSWER,
  DEMO_CATEGORY_LABEL,
  DEMO_QUESTION,
  HIDE_DEV_OVERLAY_CSS,
} from "./lib/demo-content.mjs";
// hydration の完了を待ちながら操作するヘルパー（デモ GIF 撮影と共有）
import { clickUntilPressed, waitForEnabled } from "./lib/page-actions.mjs";

// このスクリプト自身の場所からリポジトリルートを求める（どこから実行しても生成物の場所を固定する）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 定数（マジックナンバーを避けるため一元管理） ----
// 撮影用に起動する Next.js 開発サーバーのポート（通常の dev・デモ GIF 撮影と衝突しない番号）
const APP_PORT = 3101;
// アプリの URL（Next.js dev サーバーは 127.0.0.1 だと cross-origin 扱いで
// dev リソースをブロックするため、サーバー自身のオリジンと一致する localhost を使う）
const APP_URL = `http://localhost:${APP_PORT}`;
// デスクトップ撮影の画面サイズ（CLAUDE.md §15 の「幅 1280px 目安」に合わせる）
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
// モバイル撮影の画面サイズ（一般的なスマートフォン相当。既存のスクショと同じ寸法にする）
const MOBILE_VIEWPORT = { width: 390, height: 844 };
// モバイル撮影の解像度倍率。実機は高精細なので 2 倍で撮り、README で縮小表示しても粗くしない
const MOBILE_DEVICE_SCALE_FACTOR = 2;
// 生成物の出力先ディレクトリ（README が参照するパスに固定。実行時のカレントディレクトリに依存させない）
const SCREENSHOT_DIR = path.join(REPO_ROOT, "docs", "screenshots");
// next dev の起動を待つ上限時間（ミリ秒）
const APP_STARTUP_TIMEOUT_MS = 120_000;
// SIGTERM で終わらない next dev を強制終了するまでの猶予（ミリ秒）
const APP_SHUTDOWN_GRACE_MS = 10_000;
// 描画が落ち着くまでの待ち時間（ミリ秒）。フォント適用やトランジションの途中を撮らないための余白
const RENDER_SETTLE_MS = 800;
// ストリーミングのチャンク送出間隔（ミリ秒）。静止画撮影では回答を待たないため 0 でよい
const DELTA_INTERVAL_MS = 0;
// 1 回の text_delta で送る文字数（同上。速度を落とす理由が無いので大きめにする）
const DELTA_CHUNK_SIZE = 64;
// レート制限の枠を使い切るために送る試行回数の上限（安全弁）。
// アプリ側の上限（1 分 20 リクエスト）より十分大きくしつつ、429 が永久に返らない
// 場合でも無限ループにしないための打ち切り値
const MAX_RATE_LIMIT_PRIMING_REQUESTS = 100;
// レート制限超過を表す HTTP ステータス
const HTTP_TOO_MANY_REQUESTS = 429;

// 撮影する 4 枚の定義（ファイル名の唯一の一覧。README・CLAUDE.md §3 の記載と対応させる）
const SHOTS = {
  // 初期画面（カテゴリチップ表示）
  initial: "chat-initial-categories.png",
  // カテゴリ選択後、入力欄に質問を入力した画面
  categorySelected: "chat-category-selected.png",
  // レート制限超過時の日本語エラーメッセージ表示
  error: "chat-error-message.png",
  // モバイル幅での表示
  mobile: "chat-mobile.png",
};

// 起動中／起動済みの next dev プロセス（シグナルハンドラからも参照するため先に宣言する）
let appProcess = null;
// 撮影した PNG を一旦置く一時ディレクトリ（中断時にも消せるようここで保持する）
let stagingDir = null;

// ログは stderr へ出す（生成物のパスなど結果は stdout と区別する）
const log = createLogger("capture-screenshots");

/**
 * アプリ本体の DOM（見出しを含む body 直下の要素）に絞ったロケータを返す。
 * Playwright のロケータは shadow DOM も貫通して探すため、範囲を絞らないと
 * next dev が挿入する開発用オーバーレイ（<nextjs-portal> 内）まで拾ってしまう。
 * @param {import("@playwright/test").Page} page - 対象のページ
 * @returns {import("@playwright/test").Locator} アプリのルート要素
 */
function appRootOf(page) {
  // 見出しを含む body 直下の div をアプリのルートとみなす
  return page.locator("body > div").filter({ has: page.getByRole("heading", { name: APP_HEADING }) });
}

/**
 * 撮影前の共通検査を行う。アプリのルートが一意に見つかることを確認する。
 * 目印が見つからないまま次の検査へ進むと「0 件だから合格」と素通りしてしまうため、
 * レイアウト変更で検査そのものが無効化されるのを防ぐ（fail-closed）。
 * @param {import("@playwright/test").Page} page - 対象のページ
 * @param {string} shotName - 失敗時のメッセージに載せる撮影対象の名前
 * @returns {Promise<import("@playwright/test").Locator>} 検査済みのアプリのルート要素
 */
async function requireAppRoot(page, shotName) {
  // アプリのルート要素を取得する
  const appRoot = appRootOf(page);
  // ちょうど 1 件見つからなければレイアウトが変わったとみなして中止する
  if ((await appRoot.count()) !== 1) {
    throw new Error(
      `${shotName}: アプリのルート要素を特定できませんでした（レイアウト変更の可能性）。検査できないため撮影を中止します。`,
    );
  }
  // 以降の検査で使えるようルート要素を返す
  return appRoot;
}

/**
 * アプリのエラーバナー（role="alert"）が出ていないことを確認する。
 * エラー撮影以外の 3 枚は「正常時の画面」なので、赤いバナーが写り込んだ画像を
 * 成功として上書きしないためにここで弾く。
 * @param {import("@playwright/test").Locator} appRoot - アプリのルート要素
 * @param {string} shotName - 失敗時のメッセージに載せる撮影対象の名前
 */
async function requireNoErrorBanner(appRoot, shotName) {
  // アプリのエラーバナーを探す
  const errorBanner = appRoot.getByRole("alert");
  // 1 件でも出ていれば、その文言を添えて失敗させる（原因調査のため）
  if ((await errorBanner.count()) > 0) {
    const alertText = await errorBanner.first().innerText();
    throw new Error(`${shotName}: 撮影中にエラーが表示されました: ${alertText}`);
  }
}

/**
 * 撮影用のページを開き、初期画面（カテゴリチップ）が表示されるまで待つ。
 * @param {import("@playwright/test").BrowserContext} context - ページを開くコンテキスト
 * @returns {Promise<import("@playwright/test").Page>} 初期表示が整ったページ
 */
async function openAppPage(context) {
  // 新しいページを開く
  const page = await context.newPage();
  // アプリのトップページへ移動する
  await page.goto(APP_URL);
  // next dev が挿入する開発ツールのバッジ（画面左下の丸い「N」）を隠す。
  // style は文書に紐づくので、goto で読み込んだ後に入れる必要がある
  await page.addStyleTag({ content: HIDE_DEV_OVERLAY_CSS });
  // カテゴリチップが描画されるまで待つ（初期画面が整った目印）
  await page.getByRole("button", { name: DEMO_CATEGORY_LABEL }).waitFor();
  // 描画が落ち着くまで少し待つ（トランジション途中を撮らないため）
  await sleep(RENDER_SETTLE_MS);
  // 撮影可能になったページを返す
  return page;
}

/**
 * 1 枚撮影して一時ディレクトリへ書き出す。
 * 生成物を直接 docs/screenshots へ書くと、途中で失敗したときに新旧の混ざった
 * 状態がコミット対象に残ってしまうため、すべて検査を通ってから差し替える。
 * @param {import("@playwright/test").Page} page - 撮影対象のページ
 * @param {string} fileName - 出力するファイル名（SHOTS の値）
 */
async function capture(page, fileName) {
  // 一時ディレクトリ配下へビューポート範囲のスクリーンショットを書き出す
  await page.screenshot({ path: path.join(stagingDir, fileName) });
  // どの画像を撮ったか分かるようログに残す
  log(`撮影しました: ${fileName}`);
}

/**
 * ページ内から /api/chat を叩いてレート制限の枠を使い切り、429 の応答文言を返す。
 *
 * ページ内（page.evaluate）から送るのは、レート制限のキーが送信元 IP 由来のため。
 * Node 側から叩くと、環境によってはブラウザと別のキーとして数えられ、UI から送信しても
 * 429 にならない（＝エラー画面が撮れない）ことがある。
 *
 * 本文はわざと壊れた JSON にする。アプリはレート制限を数えた後・本文を解釈する前の
 * 順序で処理するため、枠だけを消費して 400 で返り、上流 Claude API には到達しない。
 * @param {import("@playwright/test").Page} page - 対象のページ
 * @returns {Promise<string>} アプリが 429 応答で返したエラーメッセージ
 */
async function primeRateLimit(page) {
  // ブラウザ内で fetch を繰り返し、429 が返った時点でその文言を持ち帰る
  const result = await page.evaluate(async (maxAttempts) => {
    // 上限回数まで繰り返す
    for (let i = 0; i < maxAttempts; i++) {
      // 壊れた JSON を送る（レート制限の枠だけ消費し、上流は呼ばれない）
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      // レート制限に当たったら、その応答本文からアプリの文言を取り出して返す
      if (res.status === 429) {
        const data = await res.json().catch(() => null);
        return { status: res.status, message: typeof data?.error === "string" ? data.error : null };
      }
    }
    // 上限回数を使い切っても 429 にならなかったことを呼び出し側へ伝える
    return { status: null, message: null };
  }, MAX_RATE_LIMIT_PRIMING_REQUESTS);

  // 429 に到達しなかった場合は、エラー画面ではない画像を撮ってしまうので中止する（fail-closed）
  if (result.status !== HTTP_TOO_MANY_REQUESTS) {
    throw new Error(
      `${MAX_RATE_LIMIT_PRIMING_REQUESTS} 回試行してもレート制限（${HTTP_TOO_MANY_REQUESTS}）に到達しませんでした。撮影を中止します。`,
    );
  }
  // 応答に文言が無いと、画面に出るはずのメッセージと突き合わせられない
  if (!result.message) {
    throw new Error(
      `レート制限の応答にエラーメッセージが含まれていませんでした。撮影を中止します。`,
    );
  }
  // 画面表示との突き合わせに使うため、アプリが返した文言を返す
  return result.message;
}

/**
 * 初期画面・カテゴリ選択・エラー表示の 3 枚をデスクトップ幅で撮影する。
 * 同じページを使い回すのは、1 枚ごとにサーバーを立て直すより速く、
 * かつ「初期画面 → 入力 → 送信」という実際の操作順序と一致するため。
 * @param {import("@playwright/test").Browser} browser - 起動済みのブラウザ
 */
async function captureDesktopShots(browser) {
  // デスクトップ幅のコンテキストを作る
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  try {
    // アプリのトップページを開く
    const page = await openAppPage(context);

    // ---- 1 枚目: 初期画面（カテゴリチップ表示） ----
    // アプリのルート要素を確認する
    const appRoot = await requireAppRoot(page, SHOTS.initial);
    // 正常時の画面なのでエラーバナーが無いことを確認する
    await requireNoErrorBanner(appRoot, SHOTS.initial);
    // 初期画面を撮影する
    await capture(page, SHOTS.initial);

    // ---- 2 枚目: カテゴリ選択 + 質問入力 ----
    // 「料理」カテゴリのチップを、選択が React に届くまで再試行しながらクリックする。
    // hydration 前のクリックは黙って捨てられるため、1 回で諦めるとカテゴリ未選択のまま
    // 撮影され、README の説明（「料理」カテゴリ選択中）と食い違う画像ができる
    const cookingChip = page.getByRole("button", { name: DEMO_CATEGORY_LABEL });
    await clickUntilPressed(cookingChip);
    // 入力欄に質問をタイプする（実際の利用に近い状態を写す）
    const input = page.getByLabel("メッセージを入力");
    await input.fill(DEMO_QUESTION);
    // 送信ボタンは disabled={isLoading || !input.trim()} なので、有効化されたことが
    // 「入力が React の state に入った」唯一の確かな証拠になる（DOM の value は
    // hydration 前の入力でも埋まってしまい、判定に使えない）
    const sendButton = page.getByRole("button", { name: "送信", exact: true });
    await waitForEnabled(sendButton, "送信ボタン");
    // 描画が落ち着くまで少し待つ
    await sleep(RENDER_SETTLE_MS);
    // ここも正常時の画面なのでエラーバナーが無いことを確認する
    await requireNoErrorBanner(appRoot, SHOTS.categorySelected);
    // カテゴリ選択 + 質問入力の状態を撮影する
    await capture(page, SHOTS.categorySelected);

    // ---- 3 枚目: エラー表示（レート制限超過） ----
    // ページ内から API を叩いて枠を使い切り、アプリが返す 429 の文言を受け取る
    const expectedMessage = await primeRateLimit(page);
    // 入力済みの質問をそのまま UI から送信する（実運用と同じ経路で 429 を受ける）
    await sendButton.click();
    // エラーバナーが出るまで待つ
    const errorBanner = appRoot.getByRole("alert");
    await errorBanner.waitFor();
    // 表示された文言がアプリの返した 429 のメッセージと一致することを確認する。
    // 「何かエラーが出た」だけを根拠にすると、通信エラー等の別のバナーを
    // レート制限の画像として README に載せてしまう（fail-closed）
    const bannerText = (await errorBanner.innerText()).trim();
    if (bannerText !== expectedMessage) {
      throw new Error(
        `${SHOTS.error}: 表示されたエラー文言が API の応答と一致しません（画面: 「${bannerText}」/ API: 「${expectedMessage}」）。撮影を中止します。`,
      );
    }
    // 描画が落ち着くまで少し待つ
    await sleep(RENDER_SETTLE_MS);
    // エラー表示を撮影する
    await capture(page, SHOTS.error);
  } finally {
    // 例外の有無にかかわらずコンテキストを閉じる（開いたままだとプロセスが終了しない）
    await context.close().catch(() => {});
  }
}

/**
 * モバイル幅の初期画面を撮影する。
 * デスクトップとは別コンテキストにするのは、Playwright が viewport や
 * deviceScaleFactor をコンテキスト単位でしか設定できないため。
 * @param {import("@playwright/test").Browser} browser - 起動済みのブラウザ
 */
async function captureMobileShot(browser) {
  // モバイル幅・高解像度のコンテキストを作る
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: MOBILE_DEVICE_SCALE_FACTOR,
  });
  try {
    // アプリのトップページを開く
    const page = await openAppPage(context);
    // アプリのルート要素を確認する
    const appRoot = await requireAppRoot(page, SHOTS.mobile);
    // 正常時の画面なのでエラーバナーが無いことを確認する
    await requireNoErrorBanner(appRoot, SHOTS.mobile);
    // モバイル表示を撮影する
    await capture(page, SHOTS.mobile);
  } finally {
    // 例外の有無にかかわらずコンテキストを閉じる
    await context.close().catch(() => {});
  }
}

/**
 * 一時ディレクトリの PNG を docs/screenshots へまとめて差し替える。
 * 4 枚すべてが揃って初めて動かすので、途中で失敗しても既存の画像は損なわれない。
 */
function publishScreenshots() {
  // 出力先ディレクトリを保証する
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  // 定義した 4 枚を順に移動する
  for (const fileName of Object.values(SHOTS)) {
    // 一時ディレクトリ上のパス
    const from = path.join(stagingDir, fileName);
    // 揃っていない場合は差し替えを中止する（撮り漏らしに気づかず古い画像を残さないため）
    if (!fs.existsSync(from)) {
      throw new Error(`${fileName} が撮影されていません。差し替えを中止します。`);
    }
    // 検査を通ったのでコミット対象のパスへ移す
    fs.renameSync(from, path.join(SCREENSHOT_DIR, fileName));
  }
  // どこへ出力したかを結果として知らせる
  log(`スクリーンショット ${Object.keys(SHOTS).length} 枚を更新しました: ${SCREENSHOT_DIR}`);
}

// ---- メイン処理 ----
// モック上流 → アプリ → 撮影 → 差し替えの順に実行し、後始末を必ず行う。
// 静止画では回答のストリーミングを待たないが、モックは「実 API を呼んでいない」ことを
// 確かめる番人として必ず立てる（呼ばれた回数を最後に検査する）
const {
  server: mockServer,
  stats: mockStats,
  port: mockUpstreamPort,
} = await startMockUpstream({
  answer: DEMO_ANSWER,
  deltaIntervalMs: DELTA_INTERVAL_MS,
  deltaChunkSize: DELTA_CHUNK_SIZE,
  log,
});
log(`モック上流を起動しました (port ${mockUpstreamPort})`);

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
  // 撮影途中の PNG が入った一時ディレクトリを消す
  if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  // モック上流の接続を切って閉じる
  mockServer.closeAllConnections();
  mockServer.close();
  // 中断による終了であることを終了コードで示す（128 + シグナル番号の慣例）
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.once("SIGINT", () => cleanUpOnSignal("SIGINT"));
process.once("SIGTERM", () => cleanUpOnSignal("SIGTERM"));

// 撮影した PNG を一旦置く一時ディレクトリを OS の一時領域に作る（移植性のため /tmp 直書きを避ける）
stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-screenshots-"));
// ブラウザは try の外で宣言し、finally で確実に閉じられるようにする
let browser = null;

try {
  // アプリを起動する。appProcess は onSpawn で spawn 直後に設定される
  // （起動待ち中に中断されても kill できるようにするため）
  await startAppServer({
    repoRoot: REPO_ROOT,
    port: APP_PORT,
    env: {
      // ダミーの API キー（モック上流しか呼ばないので実キーは不要）
      ANTHROPIC_API_KEY: "demo-dummy-key",
      // Anthropic SDK の接続先をローカルのモックへ差し替える（実際に割り当てられたポート）
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockUpstreamPort}`,
    },
    startupTimeoutMs: APP_STARTUP_TIMEOUT_MS,
    onSpawn: (child) => {
      appProcess = child;
    },
  });
  log(`アプリを起動しました (${APP_URL})`);

  // Chromium を起動する（実行ファイルの差し替え判定は E2E 設定と共有のヘルパーに任せる）
  browser = await chromium.launch(chromiumLaunchOptions());
  // デスクトップ幅の 3 枚を撮る
  await captureDesktopShots(browser);
  // モバイル幅の 1 枚を撮る
  await captureMobileShot(browser);

  // 上流が一度でも呼ばれていたら、レート制限より先へ進んだ＝実 API を叩きうる経路を
  // 通ったことになる。このスクリプトは 429 と初期表示しか撮らないので上流呼び出しは
  // 0 回が正しい。0 でなければ成果物を差し替えない（fail-closed / 課金の予防）
  if (mockStats.messagesRequests !== 0) {
    throw new Error(
      `上流への呼び出しが ${mockStats.messagesRequests} 回発生しました（想定は 0 回）。` +
        "レート制限が効いていない可能性があります。差し替えを中止します。",
    );
  }

  // すべての検査を通ったので、まとめてコミット対象へ差し替える
  publishScreenshots();
} finally {
  // ブラウザを必ず閉じる（開いたままだとプロセスが終了しない）
  if (browser) await browser.close().catch(() => {});
  // アプリのプロセスグループを終了し、実際に終わるまで待つ
  if (appProcess) await stopAppServer(appProcess, APP_SHUTDOWN_GRACE_MS);
  // 一時ディレクトリを削除する（成功時は rename 済みなので空、失敗時は撮りかけを捨てる）
  if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  // 残っている keep-alive 接続を切ってから閉じる（close() だけだと接続が残る限り完了しない）
  mockServer.closeAllConnections();
  mockServer.close();
}
