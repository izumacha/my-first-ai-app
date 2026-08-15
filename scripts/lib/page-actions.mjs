/**
 * 撮影スクリプト共通の Playwright 操作ヘルパー。
 *
 * next dev に対する撮影では、React の hydration（サーバー描画済み HTML に操作を
 * 結び付ける処理）が終わる前のクリックや入力が「リスナー未装着で黙って捨てられる」。
 * それに気づかず撮り進めると、カテゴリ未選択のまま撮影された画像や、質問が
 * 入力されていない画像が「成功」として README に載ってしまう。
 * 捨てられたことを検知して再試行・中断する判定をここへ集約する（CLAUDE.md §6 DRY）。
 */

// 待機時間と hydration の上限は撮影内容の定義側と共有する（値の二重管理を避ける）
import { sleep } from "./app-server.mjs";
import { HYDRATION_TIMEOUT_MS } from "./demo-content.mjs";

// クリック後に押下状態を確認するまでの待ち時間（ミリ秒）。React の再描画を待つ
const CLICK_SETTLE_MS = 300;
// 操作可否をポーリングする間隔（ミリ秒）
const ENABLED_POLL_INTERVAL_MS = 200;

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
