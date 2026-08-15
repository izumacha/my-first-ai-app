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
 * サーバーの起動・停止とモック上流は静止画撮影（scripts/capture-screenshots.mjs）と
 * 共有している（scripts/lib/）。このファイルには「録画して GIF にする」ことだけを残す。
 *
 * 失敗時は必ず throw して GIF を書き換えないこと（fail-closed）。README が参照する
 * 唯一のデモ資産なので、エラー画面や途中で切れた録画を「成功」として上書きすると、
 * 壊れた GIF がそのままコミットされてしまう。
 */

// 子プロセス起動（ffmpeg 実行用）を読み込む
import { spawnSync } from "node:child_process";
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
// アプリサーバーの起動・停止まわり（静止画撮影と共有）
import {
  APP_SHUTDOWN_GRACE_MS,
  APP_STARTUP_TIMEOUT_MS,
  createLogger,
  killProcessTree,
  sleep,
  startAppServer,
  stopAppServer,
} from "./lib/app-server.mjs";
// 上流 Claude API を模倣するモックサーバーと、その接続先を渡す環境変数（静止画撮影と共有）
import { startMockUpstream, stubUpstreamEnv } from "./lib/mock-upstream.mjs";
// 撮影で使う質問・回答（静止画撮影と共有）
import {
  ANSWER_TAIL_MARKER,
  DEMO_ANSWER,
  DEMO_CATEGORY_LABEL,
  DEMO_QUESTION,
} from "./lib/demo-content.mjs";
// ページの開き方・hydration 待ち・撮影前の共通検査（静止画撮影と共有）
import {
  clickUntilPressed,
  openAppPage,
  requireAppRoot,
  requireNoErrorBanner,
  waitForEnabled,
} from "./lib/page-actions.mjs";

// このスクリプト自身の場所からリポジトリルートを求める（どこから実行しても生成物の場所を固定する）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 定数（マジックナンバーを避けるため一元管理） ----
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
// 撮影開始直後に初期画面を見せる静止時間（ミリ秒）。冒頭がいきなり操作から始まらないようにする
const INTRO_SETTLE_MS = 1200;
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

// モック上流が実際に待ち受けているポート（listen 後に OS の割り当てを記録する）
let mockUpstreamPort = null;
// 起動中／起動済みの next dev プロセス（シグナルハンドラからも参照するため先に宣言する）
let appProcess = null;
// 録画の一時ディレクトリ（中断時にも消せるようここで保持する）
let videoDir = null;

// ログは stderr へ出す（生成物のパスなど結果は stdout と区別する）
const log = createLogger("capture-demo");

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
      // アプリのトップページを開き、初期画面（カテゴリチップ）が整うまで待つ
      const page = await openAppPage(context, APP_URL);
      // 撮影開始前にもう少し静止させる（録画の冒頭に落ち着いた初期画面を入れるため）
      const cookingChip = page.getByRole("button", { name: DEMO_CATEGORY_LABEL });
      await sleep(INTRO_SETTLE_MS);
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
      // 探索範囲をアプリ本体の DOM に限定し、レイアウトが変わっていないことも確認する
      const appRoot = await requireAppRoot(page, "デモ録画");
      // アプリのエラーバナー（role="alert"）が出ていないことを確認する
      await requireNoErrorBanner(appRoot, "デモ録画");
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
const {
  server: mockServer,
  stats: mockStats,
  port: upstreamPort,
} = await startMockUpstream({
  answer: DEMO_ANSWER,
  deltaIntervalMs: DELTA_INTERVAL_MS,
  deltaChunkSize: DELTA_CHUNK_SIZE,
  log,
});
// アプリへ渡す接続先として、OS が実際に割り当てたポートを控える
mockUpstreamPort = upstreamPort;
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
  // アプリを起動する。appProcess は onSpawn で spawn 直後に設定される
  // （起動待ち中に中断されても kill できるようにするため）
  await startAppServer({
    repoRoot: REPO_ROOT,
    port: APP_PORT,
    env: stubUpstreamEnv(mockUpstreamPort),
    startupTimeoutMs: APP_STARTUP_TIMEOUT_MS,
    onSpawn: (child) => {
      appProcess = child;
    },
  });
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
  if (appProcess) await stopAppServer(appProcess, APP_SHUTDOWN_GRACE_MS);
  // 録画の一時ディレクトリ（数 MB の webm）を削除する
  if (videoDir) fs.rmSync(videoDir, { recursive: true, force: true });
  // 残っている keep-alive 接続を切ってから閉じる（close() だけだと接続が残る限り完了しない）
  mockServer.closeAllConnections();
  mockServer.close();
}
