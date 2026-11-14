# Changelog

All notable changes to `@hermesihq/mcp`. This file describes what a consumer gets.

**`0.x` means the tools can still change.** A minor bump may rename or remove a tool; a patch bump will not. Each release lists
breaking changes first.

## 0.1.0 (unreleased)

### Added

- The MCP server, over stdio (`npx @hermesihq/mcp`) and as a stateless HTTP endpoint for Cloudflare Workers (`dist/worker.js`).
- Thirty tools on a management key: templates, workflows (including export, import and a dry run), categories, subscribers,
  suppressions and activity; `send_test_event` when a secret key is configured. The `setup-project` prompt.
- Needs `GET /v1/manage/key-context` on the Hermesi side, which is how a key learns its project and environment.
