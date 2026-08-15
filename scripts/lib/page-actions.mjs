/**
 * 撮影スクリプト共通の Playwright 操作ヘルパー。
 *
 * next dev に対する撮影では、React の hydration（サーバー描画済み HTML に操作を
 * 結び付ける処理）が終わる前のクリックや入力が「リスナー未装着で黙って捨てられる」。
 * それに気づかず撮り進めると、カテゴリ未選択のまま撮影された画像や、質問が
 * 入力されていない画像が「成功」として README に載ってしまう。
 * 捨てられたことを検知して再試行・中断する判定をここへ集約する（CLAUDE.md §6 DRY）。
 */

// 待機ユーティリティはサーバー側と共有する（値の二重管理を避ける）
import { sleep } from "./app-server.mjs";
// 画面上の目印（見出し・開発オーバーレイの隠蔽 CSS）は撮影内容の定義側と共有する
import { APP_HEADING, DEMO_CATEGORY_LABEL, HIDE_DEV_OVERLAY_CSS } from "./demo-content.mjs";

// hydration（React がサーバー描画済み HTML に操作を結び付ける処理）の完了を待つ上限（ミリ秒）
const HYDRATION_TIMEOUT_MS = 15_000;
// クリック後に押下状態を確認するまでの待ち時間（ミリ秒）。React の再描画を待つ
const CLICK_SETTLE_MS = 300;
// 操作可否をポーリングする間隔（ミリ秒）
const ENABLED_POLL_INTERVAL_MS = 200;
// 描画が落ち着くまでの待ち時間（ミリ秒）。フォント適用やトランジションの途中を撮らないための余白
export const RENDER_SETTLE_MS = 800;

/**
 * 要素の aria-pressed が "true" になるまでクリックを繰り返す（hydration 完了とクリック反映の確認）。
 * @param {import("@playwright/test").Locator} locator - トグルボタンのロケータ
 */
export async function clickUntilPressed(locator) {
  // 一定時間、クリックと確認を繰り返す
  const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // クリックする。hydration 前ならリスナーが無く黙って捨てられるので、後で再試行する
    await locator.click();
    // 反映を少し待ってから押下状態を確認する
    await sleep(CLICK_SETTLE_MS);
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
export async function waitForEnabled(locator, description) {
  // 一定時間ポーリングし、操作可能になったら抜ける
  const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 現在の操作可否を確認する
    if (await locator.isEnabled()) return;
    // まだなら少し待って再確認する
    await sleep(ENABLED_POLL_INTERVAL_MS);
  }
  // 操作可能にならないまま進むとクリックが 30 秒タイムアウトして原因が分かりにくいので中止する
  throw new Error(`${description}が操作可能になりませんでした。撮影を中止します。`);
}

/**
 * アプリのトップページを開き、初期画面（カテゴリチップ）が表示されるまで待つ。
 * 開発オーバーレイの隠蔽まで含めて撮影の入口を 1 か所にまとめる（2 つの撮影スクリプトで共通）。
 * @param {import("@playwright/test").BrowserContext} context - ページを開くコンテキスト
 * @param {string} appUrl - アプリのトップページ URL
 * @returns {Promise<import("@playwright/test").Page>} 初期表示が整ったページ
 */
export async function openAppPage(context, appUrl) {
  // 新しいページを開く
  const page = await context.newPage();
  // アプリのトップページへ移動する
  await page.goto(appUrl);
  // next dev が挿入する開発ツールのバッジ（画面左下の丸い「N」）を隠す。
  // 撮影は dev サーバーに対して行うため、そのままだと README の代表画像に
  // 開発時にしか出ない UI が焼き込まれてしまう。
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
 * アプリ本体の DOM（見出しを含む body 直下の要素）に絞ったロケータを返し、一意であることを確認する。
 *
 * Playwright のロケータは shadow DOM も貫通して探すため、範囲を絞らないと next dev が挿入する
 * 開発用オーバーレイ（<nextjs-portal> 内）の role="alert" まで拾ってしまう。
 * 目印が見つからないまま次の検査へ進むと「0 件だから合格」と素通りしてしまうので、
 * ちょうど 1 件見つかることをここで確かめる（レイアウト変更で検査が無効化されるのを防ぐ fail-closed）。
 *
 * セレクタがレイアウトと結び付いているため、2 つの撮影スクリプトへ書き写さずここに置く。
 * 書き写すと、レイアウト変更に気づいて直すのは実際に動かした方のスクリプトだけになり、
 * もう一方は「エラーバナーを検知できない」状態のまま静かに生成物を公開してしまう。
 * @param {import("@playwright/test").Page} page - 対象のページ
 * @param {string} context - 失敗時のメッセージに載せる撮影対象の名前
 * @returns {Promise<import("@playwright/test").Locator>} 検査済みのアプリのルート要素
 */
export async function requireAppRoot(page, context) {
  // 見出しを含む body 直下の div をアプリのルートとみなす
  const appRoot = page
    .locator("body > div")
    .filter({ has: page.getByRole("heading", { name: APP_HEADING }) });
  // ちょうど 1 件見つからなければレイアウトが変わったとみなして中止する
  if ((await appRoot.count()) !== 1) {
    throw new Error(
      `${context}: アプリのルート要素を特定できませんでした（レイアウト変更の可能性）。検査できないため撮影を中止します。`,
    );
  }
  // 以降の検査で使えるようルート要素を返す
  return appRoot;
}

/**
 * アプリのエラーバナー（role="alert"）が出ていないことを確認する。
 * 正常時の画面を撮る場面で、赤いバナーが写り込んだ画像を成功として公開しないための検査。
 * @param {import("@playwright/test").Locator} appRoot - requireAppRoot が返したルート要素
 * @param {string} context - 失敗時のメッセージに載せる撮影対象の名前
 */
export async function requireNoErrorBanner(appRoot, context) {
  // アプリのエラーバナーを探す
  const errorBanner = appRoot.getByRole("alert");
  // 1 件でも出ていれば、その文言を添えて失敗させる（原因調査のため）
  if ((await errorBanner.count()) > 0) {
    const alertText = await errorBanner.first().innerText();
    throw new Error(`${context}: 撮影中にエラーが表示されました: ${alertText}`);
  }
}
