# Contributing to ContextDeck

Thanks for your interest in contributing to **ContextDeck**!

## Local Setup

```bash
git clone <repo-url>
cd contextdeck
pnpm install
pnpm build
pnpm test
```

For active frontend development with hot reload alongside the local backend server:

```bash
# Terminal 1: Start API + SSE + MCP server with demo data
node packages/cli/dist/index.js serve --demo

# Terminal 2: Start Vite dev server (proxies /api and /mcp to :4310)
pnpm dev:web
```

## Package Structure

- `packages/core`: Pure storage, schemas, drift/staleness engine, Context Pack serialization. Keep it free of HTTP or React dependencies.
- `packages/server`: Hono REST/SSE server and MCP server (stdio + Streamable HTTP).
- `packages/cli`: User-facing `cdeck` CLI and harness setup adapters.
- `packages/web`: React + Tailwind v4 studio UI.

## Guidelines

1. Keep `.contextdeck/` file formats human-readable, diff-friendly, and backwards-compatible via Zod defaults.
2. Add Vitest tests in `packages/core/test/` or `packages/server/test/` for new storage, drift, API, or MCP behavior.
3. Run `pnpm typecheck && pnpm test && pnpm build` before opening a pull request.
