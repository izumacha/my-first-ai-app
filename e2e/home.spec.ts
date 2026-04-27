import { test, expect } from "@playwright/test";

test("home renders and can type a message", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "AI 暮らしアシスタント" })).toBeVisible();

  const input = page.getByPlaceholder("メッセージを入力...");
  await expect(input).toBeVisible();

  await input.fill("テストメッセージ");
  await expect(input).toHaveValue("テストメッセージ");
});

test("send message and receive mocked response via SSE", async ({ page }) => {
  // /api/chat を Playwright 側でモックして、SSE を返す（Anthropic には接続しない）
  await page.route("**/api/chat", async (route) => {
    const headers = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };

    const body = [
      `data: ${JSON.stringify({ text: "こんにちは。" })}\n\n`,
      `data: ${JSON.stringify({ text: "モック応答です。" })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    await route.fulfill({ status: 200, headers, body });
  });

  await page.goto("/");

  const input = page.getByPlaceholder("メッセージを入力...");
  await expect(input).toBeEnabled();

  // Hydration 前に fill すると state が更新されず、送信ボタンが disabled のままになることがある。
  // クリック→キーボード入力で確実に onChange を発火させる。
  await input.click();
  await page.keyboard.type("天気は？");
  await expect(input).toHaveValue("天気は？");

  const sendButton = page.getByRole("button", { name: "送信" });
  await expect(sendButton).toBeEnabled({ timeout: 15_000 });

  // 送信により /api/chat が呼ばれることを確認する
  await Promise.all([
    page.waitForRequest("**/api/chat"),
    sendButton.click(),
  ]);

  // ユーザーの吹き出しが表示されること
  await expect(page.getByText("あなた")).toBeVisible();
  await expect(page.getByText("天気は？")).toBeVisible();

  // AI のモック応答が表示されること
  await expect(page.getByText("AI アシスタント")).toBeVisible();
  await expect(page.getByText("こんにちは。モック応答です。")).toBeVisible();
});
