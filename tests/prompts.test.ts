/**
 * プロンプト定義のテスト
 * 各カテゴリのシステムプロンプトが正しく定義されていることを検証する。
 */
import { describe, it, expect } from "vitest";
import { CATEGORIES, getSystemPrompt } from "@/lib/prompts";
import type { CategoryId } from "@/lib/types";

describe("prompts", () => {
  // カテゴリ一覧が空でないことを確認する
  it("CATEGORIES が1件以上定義されていること", () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
  });

  // 各カテゴリに必須フィールドがあることを確認する
  it("各カテゴリに id, label, description が存在すること", () => {
    for (const category of CATEGORIES) {
      // id が空でないことを確認する
      expect(category.id).toBeTruthy();
      // label が空でないことを確認する
      expect(category.label).toBeTruthy();
      // description が空でないことを確認する
      expect(category.description).toBeTruthy();
    }
  });

  // 各カテゴリのシステムプロンプトが空でないことを確認する
  it("各カテゴリのシステムプロンプトが空でないこと", () => {
    // すべてのカテゴリ ID を取得する
    const categoryIds: CategoryId[] = CATEGORIES.map((c) => c.id);

    for (const id of categoryIds) {
      // カテゴリに対応するプロンプトを取得する
      const prompt = getSystemPrompt(id);
      // プロンプトが空文字でないことを検証する
      expect(prompt).toBeTruthy();
      // プロンプトが10文字以上であることを検証する
      expect(prompt.length).toBeGreaterThan(10);
    }
  });

  // カテゴリ未指定時に general のプロンプトが返ることを確認する
  it("カテゴリ未指定時に general のプロンプトが返ること", () => {
    // 引数なしで呼び出す
    const prompt = getSystemPrompt();
    // general のプロンプトと一致することを確認する
    const generalPrompt = getSystemPrompt("general");
    expect(prompt).toBe(generalPrompt);
  });

  // general カテゴリが必ず含まれていることを確認する
  it("general カテゴリが含まれていること", () => {
    // カテゴリ一覧から general を探す
    const general = CATEGORIES.find((c) => c.id === "general");
    // general が見つかることを確認する
    expect(general).toBeDefined();
  });
});
