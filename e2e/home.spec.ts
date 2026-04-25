import { test, expect } from "@playwright/test";

test("home renders and can type a message", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "AI 暮らしアシスタント" })).toBeVisible();

  const input = page.getByPlaceholder("メッセージを入力...");
  await expect(input).toBeVisible();

  await input.fill("テストメッセージ");
  await expect(input).toHaveValue("テストメッセージ");
});

