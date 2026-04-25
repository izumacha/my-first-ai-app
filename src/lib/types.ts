/**
 * 共通型定義
 * チャットアプリ全体で使用するインターフェース・型をまとめたファイル
 */

/** チャットメッセージの送信者を示すロール */
export type Role = "user" | "assistant";

/** 1つのチャットメッセージを表すインターフェース */
export interface Message {
  /** メッセージの送信者（ユーザーまたは AI） */
  role: Role;
  /** メッセージの本文 */
  content: string;
}

/** 生活カテゴリの識別子 */
export type CategoryId =
  | "general"
  | "cooking"
  | "cleaning"
  | "procedures"
  | "health";

/** カテゴリの表示情報を表すインターフェース */
export interface Category {
  /** カテゴリの識別子 */
  id: CategoryId;
  /** 画面に表示するラベル（日本語） */
  label: string;
  /** カテゴリの簡単な説明 */
  description: string;
}

/** チャット API へのリクエストボディ */
export interface ChatRequest {
  /** 会話履歴のメッセージ配列 */
  messages: Message[];
  /** 選択中のカテゴリ（省略時は general） */
  category?: CategoryId;
}

/** チャット API のエラーレスポンス */
export interface ChatErrorResponse {
  /** エラーメッセージ */
  error: string;
}
