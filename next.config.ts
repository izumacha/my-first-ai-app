import path from "node:path"; // パスを組み立てる Node.js 標準モジュールを読み込む
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // 本番実行に必要なファイル一式を .next/standalone にまとめて出力する
  // ファイルトレース（依存ファイルの追跡）の基準をこのプロジェクト直下に固定する。
  // 固定しないと実行環境のディレクトリ構成によって standalone 出力の階層が変わり、
  // E2E（playwright.config.ts）が参照する server.js のパスがずれてしまう。
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
