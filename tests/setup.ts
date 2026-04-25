/**
 * テストのセットアップファイル
 * jest-dom のカスタムマッチャーとクリーンアップを設定する。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 各テスト後に DOM をクリーンアップする
afterEach(() => {
  cleanup();
});
