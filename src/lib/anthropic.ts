/**
 * Anthropic クライアントの初期化
 * サーバー側でのみ使用する。フロントエンドからは直接呼ばない。
 */
import Anthropic from "@anthropic-ai/sdk";

/** Claude API で使用するモデル名（環境変数で上書き可能）。
 * 既定値は CLAUDE.md の指定どおり日付なしの完全なエイリアス "claude-sonnet-4-6" を使う。
 * 旧既定値 "claude-sonnet-4-6-20250514" は存在しないモデル ID（4.6 のエイリアスに別世代の
 * 日付サフィックスを継ぎ足したもの）で、全リクエストが 404 になっていた。 */
export const MODEL_NAME = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/** AI が生成するトークンの上限値 */
export const DEFAULT_MAX_TOKENS = 1024;

/** Anthropic クライアントのシングルトンインスタンス */
let client: Anthropic | null = null;

/**
 * Anthropic クライアントを取得する（シングルトン）
 * 初回呼び出し時にインスタンスを生成し、以降は同じインスタンスを返す。
 * @returns Anthropic クライアントインスタンス
 * @throws API キーが未設定の場合にエラーをスローする
 */
export function getAnthropicClient(): Anthropic {
  // クライアントが未生成なら新しく作成する
  if (!client) {
    // 環境変数から API キーを取得する
    const apiKey = process.env.ANTHROPIC_API_KEY;

    // API キーが設定されていない場合はエラーを投げる
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY が設定されていません。");
    }

    // Anthropic クライアントを生成する
    client = new Anthropic({ apiKey });
  }

  // シングルトンインスタンスを返す
  return client;
}
