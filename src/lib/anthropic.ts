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
 * 環境変数 `ANTHROPIC_API_KEY` が未設定のときに投げる専用のエラー型。
 *
 * 設計判断: 呼び出し側（API ルート）はこの失敗を 401 に対応付ける必要があるが、
 * 以前はエラーメッセージへの部分一致（`message.includes("ANTHROPIC_API_KEY")`）で
 * 判別していた。文字列に依存すると、この throw の文言を少し直しただけで判定が
 * 静かに外れて 500 に化けてしまう（型では守られない暗黙の結合）。型で分類できる
 * ようにして、判定と表示文言を切り離す。
 */
export class MissingApiKeyError extends Error {
  constructor() {
    // 内部（サーバログ）向けの詳細メッセージ。クライアントへはそのまま返さない
    super("ANTHROPIC_API_KEY が設定されていません。");
    // エラー名を明示して、ログやデバッガ上で種別が分かるようにする
    this.name = "MissingApiKeyError";
  }
}

/**
 * Anthropic クライアントを取得する（シングルトン）
 * 初回呼び出し時にインスタンスを生成し、以降は同じインスタンスを返す。
 * @returns Anthropic クライアントインスタンス
 * @throws {MissingApiKeyError} API キーが未設定の場合
 */
export function getAnthropicClient(): Anthropic {
  // クライアントが未生成なら新しく作成する
  if (!client) {
    // 環境変数から API キーを取得する
    const apiKey = process.env.ANTHROPIC_API_KEY;

    // API キーが設定されていない場合は専用のエラー型を投げる（呼び出し側が型で分類できる）
    if (!apiKey) {
      throw new MissingApiKeyError();
    }

    // Anthropic クライアントを生成する
    client = new Anthropic({ apiKey });
  }

  // シングルトンインスタンスを返す
  return client;
}
