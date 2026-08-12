/**
 * Playwright の Chromium 起動オプションを組み立てる共有ヘルパー。
 *
 * `npx playwright install` を実行できない環境（システム同梱の Chromium を使う
 * サンドボックス等）でもブラウザを起動できるようにするための逃げ道を、
 * E2E（playwright.config.ts）とデモ撮影（scripts/capture-demo.mjs）で共有する。
 * 同じ判定を 2 か所に書き写すと、変数名の変更時に片方だけ直し忘れて壊れるため。
 */

// ブラウザ本体のパスを上書きする環境変数の名前（この 1 か所だけが正）
export const CHROMIUM_PATH_ENV = "PLAYWRIGHT_CHROMIUM_PATH";

/**
 * Chromium の起動オプションを返す。
 * 環境変数が未設定なら空オブジェクトを返し、Playwright 既定のブラウザ解決に従わせる。
 * @returns {{ executablePath?: string }} chromium.launch() / launchOptions に渡せるオブジェクト
 */
export function chromiumLaunchOptions() {
  // 環境変数で指定された Chromium の実行ファイルパスを読む
  const executablePath = process.env[CHROMIUM_PATH_ENV];
  // 未設定（または空文字）なら上書きしない＝Playwright 既定の解決に任せる
  if (!executablePath) return {};
  // 指定があればその実行ファイルを使う
  return { executablePath };
}
