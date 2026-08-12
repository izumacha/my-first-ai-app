此処は Next.js の自動生成ブロックを預かるファイルです。

このリポジトリのコーディング規約・アーキテクチャ・運用ルールは `CLAUDE.md` に記載しています。
AI コーディングエージェントはまず `CLAUDE.md` を参照してください。

このファイルが存在する理由: `next dev` は Next.js のバージョン差分に関する注意書き
（下記の管理ブロック）を `AGENTS.md` か `CLAUDE.md` のどちらかへ自動で書き込みます。
`CLAUDE.md` の §4 以降は原本テンプレート `izumacha/claude-code-rules` と同期しているため、
そこへ自動生成ブロックが入ると原本との差分が生まれてしまいます。
`AGENTS.md` 側にブロックを置くと `next dev` は `CLAUDE.md` を書き換えないので、
同期を保ったまま注意書きも残せます
（判定ロジック: `node_modules/next/dist/server/lib/generate-agent-files.js` の `writeAgentFiles`）。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
