/**
 * ルートレイアウト
 * アプリ全体の HTML 構造とメタデータを定義する。
 */
import type { Metadata } from "next";
import "./globals.css";

/** アプリのメタデータ（タイトルと説明文） */
export const metadata: Metadata = {
  title: "AI 暮らしアシスタント",
  description:
    "日常生活のちょっとした疑問や悩みを AI がサポートするチャットアプリ",
};

/**
 * ルートレイアウトコンポーネント
 * すべてのページに共通する HTML 構造を提供する。
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // html 要素に日本語の言語属性を設定する
    <html lang="ja">
      {/* body にアンチエイリアスフォントとダークモード背景を適用する */}
      <body className="antialiased bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        {children}
      </body>
    </html>
  );
}
