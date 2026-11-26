# ContextDeck

**A local-first, Git-backed shared context board for keeping your human mental model and multiple AI coding agent sessions in sync—across any harness.**

Working across **Cursor**, **Claude Code**, **Codex**, **Grok**, and custom local skills (`idea-to-video`, quiz generators, architecture scripts) creates two painful failure modes:
1. **Cross-Session Drift:** A decision reached in one agent thread never propagates to your other chats.
2. **Mental Model Erosion:** Your own understanding changes over time, while static diagrams, explainer videos, and notes quietly go out of date.

**ContextDeck** solves both without forcing you out of your favorite tools. It acts as a neutral, Git-backed workspace (`.contextdeck/`) paired with a live local web UI, universal **MCP server** (stdio + Streamable HTTP), **CLI** (`cdeck`), and **1-click Context Packs** for browser-only chats.

---

## Key Features

- **5 Built-in Lenses (Pluggable Tabs):**
  - **Brief:** Living Markdown mental model (`brief.md`), chronological pulse (`events.jsonl`), stale-artifact alerts, and behind-revision session warnings.
  - **Sessions:** Interactive hierarchical **Session Tree/Graph** linking parent/child and sibling threads across Cursor, Claude Code, Codex, Grok, and skills—with live sync lag badges.
  - **Architecture & Decisions:** Versioned Decision Ledger (`dec_001` → superseded by `dec_003`) paired with live **Mermaid** diagrams and an embedded **Excalidraw** whiteboard saved directly to Git.
  - **Tasks:** Drag-and-drop Kanban board (`Backlog` / `In Progress` / `In Review` / `Done`) linked to sessions and decisions.
  - **Media & Mastery:** Built-in HTTP-Range video player (with chapter markers and Kokoro TTS narration transcripts for `idea-to-video` workflows), an **interactive Quiz Runner** with mastery tracking, and Markdown/HTML/JSON reference docs.
- **Automatic Staleness & Drift Detection:** When any agent or human records a decision that `supersedes` an older decision ID, ContextDeck automatically flags dependent diagrams, videos, quizzes, and open tasks as **Stale**, and shows active sessions how many revisions behind they are.
- **Harness-Agnostic Connectivity:**
  - **MCP (stdio & Streamable HTTP `/mcp`)** for Claude Code, Cursor, Codex, Windsurf, Cline, and Antigravity.
  - **CLI (`cdeck`) & Local REST/SSE API** for shell scripts and custom skills.
  - **1-Click Copy Context Pack & Paste Update** for web chats without local tool access (Grok, ChatGPT web, Claude web).
- **100% Local-First & Git-Friendly:** Plain YAML, Markdown, `.mmd`, `.excalidraw`, `.quiz.json`, and append-only `events.jsonl` files—zero cloud lock-in, zero external database daemons.

---

## Core Nomenclature

| Term | Meaning |
| :--- | :--- |
| **Board** | A topic, feature, or project workspace stored under `.contextdeck/boards/<slug>/`. |
| **Lens** | A switchable view tab (`Brief`, `Sessions`, `Architecture & Decisions`, `Tasks`, `Media & Mastery`). |
| **Session** | An external agent chat or skill run (`sess_*`) with optional `parentSessionId` hierarchy and `lastSyncedRevision`. |
| **Decision** | A versioned choice (`dec_001`) with `status` (`proposed`, `accepted`, `superseded`, `deprecated`) and `supersedes` lineage. |
| **Artifact** | Any diagram, video, audio clip, quiz, doc, task, or custom asset referencing governing decisions (`basedOnDecisions`). |
| **Context Pack** | A compact Markdown snapshot of the Board ready to inject into any MCP agent or paste into any web chat. |

---

## Quickstart

### Prerequisites
- Node.js `>= 20`
- `pnpm >= 9`

### Install & Build
```bash
pnpm install
pnpm build
```

### Launch with the Interactive Demo Board
```bash
node packages/cli/dist/index.js init --demo
node packages/cli/dist/index.js serve
```

Then open **http://127.0.0.1:4310** in your browser!
- Web UI & REST/SSE API: `http://127.0.0.1:4310`
- Streamable HTTP MCP Endpoint: `http://127.0.0.1:4310/mcp`

*(You can also link `cdeck` globally via `pnpm --filter @contextdeck/cli link --global`.)*

---

## Connecting Any Agent Harness

All generated project configs (`cdeck setup <target>`) merge idempotently into existing files, never write absolute machine paths (the workspace resolver automatically locates `.contextdeck/`, `.contextdeck.yaml`, and linked git worktrees), and support `--uninstall` to remove only ContextDeck-managed entries. Setup ownership is determined by shape: an entry identical to what `cdeck setup` writes (or a legacy v0.1 `--dir <repo>` MCP entry) is treated as ContextDeck-managed and removed by `--uninstall`, while customized entries (extra fields, custom flags, or other servers/hooks) are left alone.

> **Team prerequisite:** Committed project hook configs (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`) invoke `cdeck` directly, so `cdeck` must be available on every teammate's `PATH` (a missing binary will surface a hook error in the host harness).

### Harness Capabilities at a Glance

| Harness | Setup Command | Automatic | Manual / Not Supported |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `cdeck setup claude-code` | Stdio MCP (`.mcp.json`), startup Context Pack (`SessionStart`), per-prompt drift digest (`UserPromptSubmit`), auto-idle (`SessionEnd`) | Requires `cdeck` on `PATH` |
| **Codex CLI** | `cdeck setup codex` (+ `agents-md`) | Project MCP (`.codex/config.toml`), startup Context Pack (`SessionStart`), per-prompt drift digest (`UserPromptSubmit`), auto-idle (`SessionEnd`) respecting `additionalContextLimit` | Requires `cdeck` on `PATH`; Codex executes project `.codex/hooks.json` hooks only in a trusted project |
| **Cursor** | `cdeck setup cursor` | Stdio MCP (`.cursor/mcp.json`), startup Context Pack (`sessionStart`), throttled post-tool drift digest (`postToolUse`, max once per 60s), auto-idle (`sessionEnd`), always-apply rule | **No prompt-submit injection** — Cursor's `beforeSubmitPrompt` hook cannot inject additional context (as of Cursor docs fetched 2026-11-25); mid-session push happens via `postToolUse` |
| **Grok Bot** | `cdeck setup grok` | Project MCP (`.grok/config.toml`) + `AGENTS.md` protocol | **No lifecycle hooks** — syncs via MCP tools (`board_get_brief`, `decision_record`, etc.) guided by `AGENTS.md` |
| **Gemini / Antigravity** | `cdeck setup antigravity [--apply]` | Stdio MCP (`agy mcp add contextdeck cdeck mcp`) + `AGENTS.md` protocol | **No lifecycle hooks** — syncs via MCP tools guided by `AGENTS.md` |
| **Web Chats** (Grok Web, ChatGPT, Claude Web) | _(no setup needed)_ | — | **Copy Context Pack** / **Paste Update** in the web UI (or `cdeck brief --pack`) |

### Claude Code
```bash
cdeck setup claude-code
# Remove only ContextDeck entries:
cdeck setup claude-code --uninstall
```
Merges the `contextdeck` stdio server into `.mcp.json` (`cdeck mcp`, no `--dir`) and adds `SessionStart`, `UserPromptSubmit`, and `SessionEnd` hooks into `.claude/settings.json`. Pre-existing hooks and servers are preserved untouched.

### Codex CLI
```bash
cdeck setup codex
cdeck setup agents-md
# Remove only ContextDeck entries:
cdeck setup codex --uninstall
```
Merges `[mcp_servers.contextdeck]` inside `# contextdeck:start` / `# contextdeck:end` markers in `.codex/config.toml` and adds `SessionStart`, `UserPromptSubmit`, and `SessionEnd` hooks into `.codex/hooks.json` (with `additionalContextLimit` on context-emitting events and `timeout: 3` on `SessionEnd`; Codex enables hooks by default, but only runs project `.codex/hooks.json` hooks in a trusted project and requires `cdeck` on every teammate's `PATH`).

### Cursor
```bash
cdeck setup cursor
# Remove only ContextDeck entries:
cdeck setup cursor --uninstall
```
Merges `.cursor/mcp.json`, `.cursor/hooks.json` (`version: 1` with `sessionStart`, throttled `postToolUse`, and `sessionEnd`), and `.cursor/rules/contextdeck.mdc`. Because Cursor's `beforeSubmitPrompt` hook cannot inject `additional_context` (as of docs fetched 2026-11-25), live drift digests are injected via `postToolUse` (at most once every 60 seconds per session, never advancing the sync cursor when throttled).

### Grok Bot
```bash
cdeck setup grok
# Equivalent Grok CLI command:
grok mcp add --scope project contextdeck -- cdeck mcp
```
Merges `[mcp_servers.contextdeck]` into project-scope `.grok/config.toml` and updates `AGENTS.md`. Grok Bot has no lifecycle hooks configured here; it relies on MCP tools and `AGENTS.md`.

### Gemini / Antigravity
```bash
# Print the registration command and update AGENTS.md:
cdeck setup antigravity
# Or also execute `agy mcp add contextdeck cdeck mcp`:
cdeck setup antigravity --apply
```
Antigravity has no lifecycle hooks; it connects via MCP and `AGENTS.md`. Passing a stable `externalRef` on `session_register` deduplicates repeat calls without creating duplicate session records.

### Universal (`AGENTS.md`)
```bash
cdeck setup agents-md
```
Merges a marker-bounded ContextDeck protocol block into `AGENTS.md` instructing agents to reuse hook-injected `sessionId`s (without calling `session_register` again) and record decisions/supersessions via MCP.

### Multi-Board Routing & Switching
- Sessions are workspace-scoped under `.contextdeck/sessions/<id>.yaml` (metadata only); volatile sync cursors live in gitignored `.contextdeck/.runtime/cursors/<id>.json` so hooks never dirty `git status`.
- Boards may declare `paths` globs (e.g. `packages/web/**`) and `parentBoard` in `board.yaml`. Hooks automatically route new sessions to the most specific matching board (longest literal prefix, then segment count, then slug).
- Rebind the workspace default board or a specific session anytime:
  ```bash
  cdeck board use <slug>
  cdeck board use <slug> --session <sessionId>
  ```
- In `--global` mode, `cdeck board use <slug>` rewrites the project's `.contextdeck.yaml` pointer (in addition to the global workspace's `workspace.yaml`), which shows up as a working-tree change if `.contextdeck.yaml` is committed; each linked git worktree has its own copy of `.contextdeck.yaml`.

### Grok / ChatGPT Web / Claude Web
Click **Copy Context Pack** in the top bar and paste it into any browser chat. When the chat reaches new decisions or tasks, copy its fenced JSON update block and click **Paste Update** in ContextDeck.

### Custom Skills (`idea-to-video`, Quiz Generators, etc.)
```bash
# Attach a generated Kokoro TTS explainer video with transcript & governing decisions
cdeck media add "OAuth Flow Walkthrough" \
  --type video \
  --file ./out/oauth-explainer.mp4 \
  --transcript ./out/oauth-script.txt \
  --based-on dec_002,dec_003 \
  --tags idea-to-video,kokoro

# Publish a generated interactive quiz JSON file
cdeck quiz add --file ./out/oauth-quiz.json
```

---

## MCP Tools Exposed

| Tool | Purpose |
| :--- | :--- |
| `board_list` | List all boards in `.contextdeck/`. |
| `board_get_brief` | Fetch the living Context Pack (optionally syncing a `sessionId` and returning missed events). |
| `board_update_brief` | Update `brief.md`. |
| `board_check_drift` | Inspect stale artifacts and drifted sessions. |
| `session_register` | Register a session with harness badge and optional `parentSessionId`. |
| `session_update` | Update session status, summary, or hierarchy links. |
| `decision_record` | Record a decision (passing `supersedes` auto-flags dependent artifacts as stale). |
| `task_upsert` | Create or move a Kanban task. |
| `diagram_upsert` | Create or update a Mermaid or Excalidraw diagram. |
| `media_attach` | Attach a video, audio clip, Markdown doc, HTML widget, or custom artifact. |
| `quiz_create` | Publish an interactive knowledge-check quiz. |
| `artifact_refresh` | Mark a stale artifact aligned with the latest superseding decisions. |

Resources: `contextdeck://brief` (`text/markdown`), `contextdeck://snapshot` (`application/json`).

---

## Monorepo Architecture

```text
packages/
├── core/    # @contextdeck/core   — Git-backed BoardStore, Zod schemas, drift engine, Context Pack
├── server/  # @contextdeck/server — Hono REST API, SSE live push, Range media streaming, MCP (stdio + HTTP)
├── cli/     # @contextdeck/cli    — `cdeck` / `contextdeck` CLI + harness setup adapters
└── web/     # @contextdeck/web    — React 19 + Vite + Tailwind v4 + React Flow + Mermaid + Excalidraw
```

## Development & Tests

```bash
pnpm test       # Run Vitest unit & API/MCP integration tests
pnpm build      # Build all TypeScript packages & production web UI bundle
pnpm typecheck  # Strict TypeScript check across all packages
```

## License

MIT — see [LICENSE](./LICENSE).
