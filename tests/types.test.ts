/**
 * 型定義のテスト
 * TypeScript の型が正しく使用できることをランタイムで検証する。
 */
import { describe, it, expect } from "vitest";
import type { Message, Category, ChatRequest, CategoryId } from "@/lib/types";

describe("types", () => {
  // Message 型のオブジェクトが正しく作成できることを確認する
  it("Message オブジェクトが作成できること", () => {
    // ユーザーメッセージを作成する
    const userMsg: Message = { role: "user", content: "こんにちは" };
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("こんにちは");

    // AI メッセージを作成する
    const aiMsg: Message = { role: "assistant", content: "はい、こんにちは！" };
    expect(aiMsg.role).toBe("assistant");
    expect(aiMsg.content).toBe("はい、こんにちは！");
  });

  // Category 型のオブジェクトが正しく作成できることを確認する
  it("Category オブジェクトが作成できること", () => {
    const cat: Category = {
      id: "cooking",
      label: "料理",
      description: "レシピや食材の使い方",
    };
    expect(cat.id).toBe("cooking");
    expect(cat.label).toBe("料理");
  });

  // ChatRequest 型のオブジェクトが正しく作成できることを確認する
  it("ChatRequest オブジェクトが作成できること", () => {
    const req: ChatRequest = {
      messages: [{ role: "user", content: "テスト" }],
      category: "health",
    };
    expect(req.messages).toHaveLength(1);
    expect(req.category).toBe("health");
  });

  // ChatRequest の category は省略可能であることを確認する
  it("ChatRequest の category は省略可能であること", () => {
    const req: ChatRequest = {
      messages: [{ role: "user", content: "テスト" }],
    };
    expect(req.category).toBeUndefined();
  });

  // CategoryId の値が正しいことを確認する
  it("CategoryId に有効な値を代入できること", () => {
    const ids: CategoryId[] = [
      "general",
      "cooking",
      "cleaning",
      "procedures",
      "health",
    ];
    expect(ids).toHaveLength(5);
  });
});
