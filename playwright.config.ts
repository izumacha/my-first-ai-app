import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    // standalone サーバーは静的アセットを同じ階層に置く必要があるため、ビルド後に .next/static と public をコピーする。
    // 出力先は next.config.ts の outputFileTracingRoot 固定により、どの環境でも .next/standalone 直下になる。
    command:
      'bash -lc "npm run build && ' +
      'rm -rf .next/standalone/.next/static .next/standalone/public && ' +
      'cp -R .next/static .next/standalone/.next/static && ' +
      // public はこのリポジトリには無い（Next.js では任意）ため、存在するときだけコピーする
      'if [ -d public ]; then cp -R public .next/standalone/public; fi && ' +
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

