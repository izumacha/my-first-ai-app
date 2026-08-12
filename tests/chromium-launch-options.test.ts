/**
 * scripts/lib/chromium-launch-options.mjs の契約テスト。
 *
 * このヘルパーは E2E（playwright.config.ts）とデモ撮影（scripts/capture-demo.mjs）の
 * 両方でブラウザ解決を決めるため、戻り値の形が崩れても型チェックでは気づけない。
 * 「未設定なら Playwright 既定に任せる（空オブジェクト）」という契約を機械的に守る。
 */
import { afterEach, describe, expect, it } from "vitest";
// 検証対象のヘルパーを読み込む
import { chromiumLaunchOptions } from "../scripts/lib/chromium-launch-options.mjs";

// テストで書き換える環境変数の名前
const ENV_NAME = "PLAYWRIGHT_CHROMIUM_PATH";

// 各テストの後に環境変数を消して、他のテストへ影響させない
afterEach(() => {
  delete process.env[ENV_NAME];
});

describe("chromiumLaunchOptions", () => {
  it("環境変数が未設定なら空オブジェクトを返す（Playwright 既定の解決に任せる）", () => {
    // 未設定の状態を作る
    delete process.env[ENV_NAME];
    // 空オブジェクトであることを確認する（executablePath: undefined ではない点が重要）
    expect(chromiumLaunchOptions()).toEqual({});
  });

  it("空文字なら空オブジェクトを返す（空パスでの起動失敗を防ぐ）", () => {
    // 空文字を設定する（シェルで変数を空のまま渡した場合を想定）
    process.env[ENV_NAME] = "";
    // 空文字は「指定なし」とみなす
    expect(chromiumLaunchOptions()).toEqual({});
  });

  it("パスが設定されていれば executablePath として返す", () => {
    // 実行ファイルのパスを設定する
    process.env[ENV_NAME] = "/opt/chromium/chrome";
    // そのパスがそのまま executablePath になることを確認する
    expect(chromiumLaunchOptions()).toEqual({ executablePath: "/opt/chromium/chrome" });
  });
});
