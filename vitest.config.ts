/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Vitest の設定ファイル
export default defineConfig({
  // React の JSX 変換プラグインを適用する
  plugins: [react()],
  test: {
    // ブラウザ API のシミュレーション環境として jsdom を使用する
    environment: "jsdom",
    // テストファイルの検索パターン
    include: ["tests/**/*.test.{ts,tsx}"],
    // テストのセットアップファイルを指定する
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    // パスエイリアス @ を src/ にマッピングする
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
