# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AI 暮らしアシスタント — 日常生活の疑問に AI がチャットで回答する Next.js アプリ。UI テキストは日本語。

## Commands

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # Production build
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run test         # Vitest
```

## Architecture

**Stack:** Next.js 15 (App Router), TypeScript, Anthropic Claude API (claude-sonnet-4-6), Vercel AI SDK, Tailwind CSS v4, Vitest

### Layer layout

- `src/app/page.tsx` — メインチャット画面（Client Component）
- `src/app/api/chat/route.ts` — Claude API へのストリーミングプロキシ。API キーをサーバー側で安全に保持する。
- `src/components/` — UI コンポーネント（ChatMessage, ChatInput, ChatContainer, CategoryChips）
- `src/lib/anthropic.ts` — Anthropic クライアントの初期化（シングルトン）
- `src/lib/prompts.ts` — カテゴリ別システムプロンプト定義。プロンプト変更はここのみで行う。
- `src/lib/types.ts` — 共通型定義（Message, Category, ChatRequest 等）

### API ルート設計

`POST /api/chat` が唯一の API エンドポイント:
- リクエスト: `{ messages: Message[], category?: string }`
- レスポンス: Server-Sent Events（ストリーミング）
- カテゴリに応じたシステムプロンプトを `prompts.ts` から取得し、Claude API に転送する。
- API キーはサーバー側の環境変数 `ANTHROPIC_API_KEY` から取得。フロントエンドに露出させない。

## Coding conventions

### TypeScript

- `strict: true` を維持する。`any` は禁止。型が不明な場合は `unknown` を使う。
- コンポーネントの Props は `interface` で定義（`type` ではなく）。
- パスエイリアス `@/*` → `src/*` を使用する。

### コンポーネント

- Server Component をデフォルトにする。`useState` / `useEffect` が必要な場合のみ `'use client'` を付ける。
- コンポーネントファイル名は PascalCase（`ChatMessage.tsx`）。
- 1 ファイル = 1 コンポーネント。ヘルパーコンポーネントが必要なら別ファイルに分ける。

### スタイリング

- Tailwind CSS のユーティリティクラスのみ使用。カスタム CSS は `globals.css` の CSS 変数定義のみ。
- レスポンシブ対応: モバイルファーストで設計し、`sm:` / `md:` / `lg:` で拡張する。

### AI / プロンプト管理

- システムプロンプトは `src/lib/prompts.ts` に集約する。コンポーネントやルートハンドラに直接書かない。
- プロンプトは日本語で記述する（ユーザーが日本語で質問するため）。
- モデル名（`claude-sonnet-4-6` 等）は環境変数または定数で管理し、コード中にハードコードしない。
- `max_tokens` はデフォルト 1024。長い回答が必要なカテゴリは `prompts.ts` で個別設定。

### セキュリティ

- `ANTHROPIC_API_KEY` は絶対にフロントエンドに露出させない。必ず API ルート（サーバー側）経由で Claude を呼ぶ。
- ユーザー入力はサニタイズしてから Claude に渡す。HTML タグや script インジェクションを防ぐ。
- レート制限: API ルートに簡易レート制限を実装する（IP ベース、1 分あたり 20 リクエスト目安）。
- `.env.local` / `.env` をコミットしない。`.env.example` にキー名だけ記載する。

### エラーハンドリング

- API ルートでは `try-catch` で Claude API エラーをキャッチし、適切な HTTP ステータスコードを返す。
  - 401: API キー未設定 / 無効
  - 429: レート制限超過
  - 500: その他のサーバーエラー
- フロントエンドではエラー時にユーザーフレンドリーな日本語メッセージを表示する。

### テスト

- テストフレームワーク: Vitest
- テストファイル: `tests/**/*.test.ts`（ユニット）, `tests/**/*.test.tsx`（コンポーネント）
- API ルートのテストでは Anthropic API をモックする（実際の API を呼ばない）。
- プロンプト定義のテスト: 各カテゴリのシステムプロンプトが空でないことを検証する。

### Git 規約

- コミットメッセージ形式: `type(scope): 日本語の説明`
  - type: feat, fix, refactor, test, docs, chore
  - scope: chat, api, ui, prompts 等
- 例: `feat(chat): ストリーミング応答の実装`

### コメント規約

- **1行ごとに初心者でも意味がわかるコメントを書く**: コード 1 行ごとに、プログラミング初心者でも処理内容が理解できる日本語コメントを付ける。変数宣言・条件分岐・関数呼び出し・ループ・return など、すべての実行行に対して「何をしているか」を説明するコメントを必ず添える（型定義の単純な再エクスポートなど明らかに自明な行は除く）。コメントは行の直前または行末に記述し、専門用語を使うときは平易な言い換えを併記する。
