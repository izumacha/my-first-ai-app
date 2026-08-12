import { defineConfig, devices } from "@playwright/test";
// ブラウザ起動オプションの組み立ては撮影スクリプトと共有する（重複定義を避けるため）
import { chromiumLaunchOptions } from "./scripts/lib/chromium-launch-options.mjs";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    // ブラウザ本体のパスを環境変数で上書きできるようにする逃げ道（判定の実体は共有ヘルパー側）
    launchOptions: chromiumLaunchOptions(),
  },
  webServer: {
    // standalone サーバーは静的アセットの同梱が必要なので .next/static をコピーしてから起動する。
    // server.js の位置は next.config.ts の outputFileTracingRoot 指定により
    // .next/standalone/server.js に固定されている（実行環境のパスに依存しない）。
    // 旧設定は特定環境のパス（.next/standalone/github/my-first-ai-app/...）を
    // ハードコードしており、他の環境では起動に失敗していた。
    // public/ ディレクトリはこのリポジトリに存在しないためコピーしない。
    command:
      'bash -lc "npm run build && ' +
      "rm -rf .next/standalone/.next/static && " +
      "cp -R .next/static .next/standalone/.next/static && " +
      'node .next/standalone/server.js --port 3000"',
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

