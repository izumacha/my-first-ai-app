import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker 実行用に、依存を同梱した自己完結型の standalone 出力を生成する
  output: "standalone",
  // standalone 出力のルートをこのプロジェクト直下に固定する。
  // 未指定だと Next.js が親ディレクトリのロックファイル等からワークスペースルートを
  // 推測し、実行環境によって .next/standalone 配下の階層（server.js の位置）が
  // 変わってしまう。Dockerfile と playwright.config.ts は
  // .next/standalone/server.js の平坦な配置を前提にしているため、ここで固定する
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
