# ContextDeck

**A local-first, Git-backed shared context board for keeping a human mental model and multiple AI coding agent sessions in sync across harnesses.**

Working across **Claude Code**, **Codex CLI**, **Cursor**, **Grok**, **Antigravity**, and custom local skills creates two failure modes:
1. **Cross-session drift:** A decision reached in one agent session never reaches your other live sessions.
2. **Mental-model erosion:** Decisions evolve while your diagrams, explainer videos, quizzes, and own understanding quietly go out of date.

ContextDeck stores your project's living context in plain YAML, Markdown, and JSON files (`.contextdeck/` in-repo or outside the repo via `--global`), paired with a local web UI, universal **MCP server** (stdio and Streamable HTTP), **CLI** (`cdeck`), harness lifecycle hooks, local refresh workers, and 1-click **Context Packs** for browser chats.

For how ContextDeck compares to existing tools, see [Prior art](./docs/prior-art.md).

---

## Core Concepts

| Term | Meaning |
| :--- | :--- |
| **Board** | A topic, feature, or project workspace stored under `.contextdeck/boards/<slug>/` (optionally scoped by `paths` globs and `parentBoard`). |
| **Lens** | A switchable view tab: **Catch up**, **Brief**, **Sessions**, **Architecture & Decisions**, **Tasks**, and **Media & Mastery**. |
| **Session** | A workspace-scoped external agent chat or skill run (`sess_*`) with optional `parentSessionId` hierarchy and volatile per-board sync cursors. |
| **Decision** | A versioned choice (`dec_001`) with `status` (`proposed`, `accepted`, `superseded`, `deprecated`) and `supersedes` lineage. |
| **Artifact** | A versioned diagram, video/audio explainer, doc, HTML widget, or quiz referencing governing decisions (`basedOnDecisions`). |
| **Context Pack** | A bounded Markdown snapshot of the Board prioritized for MCP agents, hooks, or pasting into web chats. |

---

## What's in v0.2

- **Human Catch up lens & reader cursors:** Tracks what *you* have and have not seen per reader and per board (`.contextdeck/.runtime/readers/<readerId>.yaml`, gitignored, zero reader noise in `events.jsonl`). Opening the app lands on **Catch up** whenever unseen changes exist, showing changed decisions (`old -> new`), newly stale artifacts, moved tasks, new sessions, and other meaningful changes, with an unseen count badge in the header.
- **Confirm vs. Refresh (no silent clearing):** Stale artifacts offer two explicit actions:
  - **Queue refresh** (1-tap): creates a deduplicated refresh job (`.contextdeck/boards/<slug>/jobs/<id>.yaml`) with atomic claiming, 15-minute lease TTL, claim-bound artifact writes (`jobId` + active `leaseToken`), and strict completion verification.
  - **Still accurate**: records an auditable confirmation against the displayed replacement decision (`confirmations` map) without rewriting `basedOnDecisions`. Confirmations reject with `409 Conflict` if the artifact version or superseding decision changed since display, and automatically re-stale if superseded again. Agent confirmations via MCP require a non-blank `note` and are labeled as agent confirmations.
- **Versioned artifacts & media pruning:** Diagrams, media, and quizzes track `version` and capped `history` (last 10 versions). Media binaries are stored as immutable `<id>.v<N>.<ext>` files; quiz updates preserve all past human mastery attempts; `cdeck media prune` reclaims old media files while protecting current and open-job input files.
- **Local refresh workers (`cdeck worker`):** Run user-local video-explainer, quiz, or diagram scripts against queued jobs with explicit `cdeck worker trust` SHA-256 verification and `spawn(..., { shell: false })`. See [Refresh Job Handlers](./docs/handlers.md).
- **Per-question quiz staleness & mastery trends:** Quiz questions reference `relatedDecisionIds` so only questions affected by a superseded decision are flagged stale, alongside a per-quiz mastery score trend across attempts.
- **Fast, mobile-ready UI with dark/light theme:** Heavy visualizations (React Flow, Mermaid, Excalidraw) are lazy-loaded on demand; all 6 lenses fit a `390px` phone viewport with zero horizontal overflow and support dark/light theme switching.

---

## Quickstart

### Prerequisites
- Node.js `>= 20`
- `pnpm >= 9`

### Install & Build
```bash
pnpm install
pnpm build

# Optional: put `cdeck` and `contextdeck` on your PATH globally
pnpm --filter @contextdeck/cli link --global
```

### Initialize & Launch the Demo Board
```bash
cdeck init --demo
cdeck serve
```

`cdeck serve` binds to `127.0.0.1:4310` and prints a **single-use launch URL** (`http://127.0.0.1:4310/auth?code=...`, valid for 120 seconds). Open that launch URL in your browser to start an authenticated session. Need a fresh link later? Run:

```bash
cdeck open
```

---

## Workspace Storage: In-Repo, Global, and Git Worktrees

- **In-repo (default):** `cdeck init` creates `.contextdeck/` in your repository and adds `.contextdeck/.runtime/`, `.contextdeck/.cache/`, and `.contextdeck/.lock` to `.gitignore`. Entities stay plain YAML/Markdown/JSON so teams can diff and review context in Git.
- **Global (out-of-repo):** `cdeck init --global <name>` stores the deck under `~/.contextdeck/workspaces/<name>` and writes a tiny `.contextdeck.yaml` pointer in the project root.
- **Linked git worktrees:** ContextDeck resolves linked git worktrees automatically (pure-filesystem `.git` → `commondir` lookup) so parallel agent worktrees share one board without absolute machine paths in config files.
- **Multi-board routing:** Declare `paths` globs and optional `parentBoard` in `board.yaml`; hooks route sessions to the most specific matching board. Switch default or per-session boards with:
  ```bash
  cdeck board use <slug>
  cdeck board use <slug> --session <sessionId>
  ```

---

## Connecting Agent Harnesses

All `cdeck setup <target>` commands merge idempotently into existing project files, never write absolute machine paths, and support `--uninstall` to remove only ContextDeck-managed entries.

> **Team prerequisite:** Project hook configs (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`) invoke `cdeck` directly, so `cdeck` must be on `PATH`.

### Harness Capabilities at a Glance

| Harness | Setup Command | Automatic | Manual / Notes |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `cdeck setup claude-code` | Stdio MCP (`.mcp.json`), startup Context Pack (`SessionStart`), per-prompt drift digest (`UserPromptSubmit`), auto-idle (`SessionEnd`) | Requires `cdeck` on `PATH` |
| **Codex CLI** | `cdeck setup codex` (+ `agents-md`) | Project MCP (`.codex/config.toml`), startup Context Pack (`SessionStart`), per-prompt drift digest (`UserPromptSubmit`), auto-idle (`SessionEnd`) | Requires `cdeck` on `PATH`. **Run `/hooks` inside Codex CLI to review and trust `.codex/hooks.json`** (ContextDeck never modifies `~/.codex/config.toml`) |
| **Cursor** | `cdeck setup cursor` | Stdio MCP (`.cursor/mcp.json`), startup Context Pack (`sessionStart`), throttled post-tool drift digest (`postToolUse`, max once per 60s), auto-idle (`sessionEnd`), always-apply rule | **No prompt-submit injection** — Cursor's `beforeSubmitPrompt` hook cannot inject additional context; mid-session drift push runs via `postToolUse` |
| **Grok Bot** | `cdeck setup grok` | Project MCP (`.grok/config.toml`) + `AGENTS.md` protocol | **No lifecycle hooks** — syncs via MCP tools guided by `AGENTS.md` |
| **Gemini / Antigravity** | `cdeck setup antigravity [--apply]` | Stdio MCP (`agy mcp add contextdeck cdeck mcp`) + `AGENTS.md` protocol | **No lifecycle hooks** — syncs via MCP tools guided by `AGENTS.md` |
| **Web Chats** (Grok Web, ChatGPT, Claude Web) | _(none)_ | — | Use **Copy Context Pack** and **Paste Update** in the header (or `cdeck brief --pack`) |

### Claude Code
```bash
cdeck setup claude-code
cdeck setup claude-code --uninstall
```
Merges `contextdeck` into `.mcp.json` and adds `SessionStart`, `UserPromptSubmit`, and `SessionEnd` hooks into `.claude/settings.json`.

### Codex CLI
```bash
cdeck setup codex
cdeck setup agents-md
cdeck setup codex --uninstall
```
Merges `[mcp_servers.contextdeck]` inside `# contextdeck:start` / `# contextdeck:end` markers in `.codex/config.toml` and writes `SessionStart`, `UserPromptSubmit`, and `SessionEnd` hooks into `.codex/hooks.json`.

> **Important:** After running `cdeck setup codex`, open Codex CLI in the repo and run `/hooks` to review and trust the project hooks. ContextDeck intentionally does not edit your personal `~/.codex/config.toml`.

### Cursor
```bash
cdeck setup cursor
cdeck setup cursor --uninstall
```
Merges `.cursor/mcp.json`, `.cursor/hooks.json` (`sessionStart`, throttled `postToolUse`, `sessionEnd`), and `.cursor/rules/contextdeck.mdc`. Because Cursor's `beforeSubmitPrompt` hook cannot inject additional context, live drift digests are delivered via `postToolUse` (at most once every 60 seconds per session).

### Grok Bot, Antigravity, and `AGENTS.md`
```bash
cdeck setup grok
cdeck setup antigravity --apply
cdeck setup agents-md
```

---

## Refresh Jobs & Local Workers

Queue refreshes from the UI (**Queue refresh**) or CLI:

```bash
cdeck job create media art_explainer --reason "Updated after dec_003"
cdeck job list
```

To process queued jobs locally with your own scripts or skills (video explainers, quiz generators, diagram pipelines), configure user-local `~/.contextdeck/worker.yaml`, approve it, and start a worker:

```bash
cdeck worker trust
cdeck worker --once
# or poll continuously (seconds via --interval, or milliseconds via --poll-ms):
cdeck worker --interval 5
```

See [docs/handlers.md](./docs/handlers.md) for the full worker configuration schema, environment contract, and worked video-explainer and quiz handler examples.

---

## Security Model

- **Loopback by default:** `cdeck serve` binds strictly to `127.0.0.1` and enforces strict `Host` and `Origin` validation (rejecting DNS rebinding and `Origin: null`). LAN/phone access requires explicit `--allow-remote` and `--allowed-hosts <csv>` and prints a plain-HTTP warning.
- **Cookie + CSRF browser auth, bearer token for API/MCP:** A per-workspace 32-byte random bearer token lives in `<deck>/.runtime/token` (mode `0600`). Browser sessions authenticate via single-use launch URLs (`/auth?code=...`) that set an `HttpOnly; SameSite=Strict` cookie paired with an in-memory CSRF token (`X-CSRF-Token`) — zero auth or CSRF tokens are ever stored in `localStorage` (only the optional UI theme preference `contextdeck_theme` is persisted).
- **Sandboxed content rendering:** Markdown and Mermaid SVGs are sanitized via DOMPurify; inline HTML artifacts render inside `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) with a strict `default-src 'none'` CSP meta header; direct downloads of HTML/SVG media files are forced to `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`.
- **Safe file storage & worker isolation:** Atomic temp-file-and-rename transactions with cross-process locking (`proper-lockfile`), strict slug/ID path containment, streaming byte-capped multipart uploads, and zero server-side command execution (`cdeck worker` runs only user-local, explicitly SHA-256-trusted `argv` handlers with `shell: false`).

---

## MCP Tools Exposed

| Tool | Purpose |
| :--- | :--- |
| `board_list` | List all boards in the workspace. |
| `board_get_brief` | Fetch the bounded Context Pack (optionally syncing a `sessionId` and returning missed events). |
| `board_update_brief` | Update `brief.md` (supports optimistic locking via `baseRevision`). |
| `board_check_drift` | Inspect stale artifacts and behind-revision sessions. |
| `session_register` | Register a session with harness badge, optional `externalRef`, and `parentSessionId`. |
| `session_update` | Update session status, summary, or hierarchy links. |
| `decision_record` | Record a decision (passing `supersedes` automatically flags dependent artifacts as stale). |
| `task_upsert` | Create or move a Kanban task. |
| `diagram_upsert` | Create or publish a new version of a Mermaid or Excalidraw diagram (supports `jobId` + `leaseToken` & `note`). |
| `media_attach` | Attach a video, audio clip, Markdown doc, HTML widget, or custom artifact. |
| `media_update` | Publish a new immutable version (`<id>.v<N>.<ext>`) of an existing media artifact (supports `jobId` + `leaseToken` & `note`). |
| `quiz_create` | Publish an interactive knowledge-check quiz. |
| `quiz_update` | Publish a new version of a quiz while preserving past human mastery attempts (supports `jobId` + `leaseToken` & `note`). |
| `artifact_confirm` | Record an agent confirmation (requires non-blank `note`; optional `artifactVersion` & `expectedAgainst` conflict checks). |
| `job_list` | List refresh jobs (`leaseToken` omitted; optionally filtered by status). |
| `job_claim` | Atomically claim a queued refresh job (returns `leaseToken` and 15-minute lease expiry). |
| `job_renew` | Renew an active job lease using `leaseToken`. |
| `job_release` | Release a claimed job back to `queued` using `leaseToken`. |
| `job_complete` | Mark a claimed job `done` (verifying `version > baseVersion` created by the active claim with changed content/file) or `failed`. |

Resources: `contextdeck://brief` (`text/markdown`), `contextdeck://snapshot` (`application/json`).

---

## Monorepo Architecture

```text
packages/
├── core/    # @contextdeck/core   — Plain-file BoardStore, Zod schemas, drift/catch-up engine, Context Pack, worker config
├── server/  # @contextdeck/server — Hono REST/SSE API, Range media streaming, auth/CSP, MCP (stdio + Streamable HTTP)
├── cli/     # @contextdeck/cli    — `cdeck` / `contextdeck` CLI, harness setup/hooks, local refresh worker
└── web/     # @contextdeck/web    — React 19 + Vite + Tailwind v4 (lazy React Flow, Mermaid, Excalidraw)
```

## Development & Verification

```bash
pnpm typecheck   # Strict TypeScript check across all packages
pnpm test        # Unit, storage/concurrency, server/MCP, CLI/hook, and web security tests
pnpm build       # Build all packages and production web UI bundle
pnpm test:e2e    # Playwright end-to-end smoke, 390px layout, and browser isolation tests
pnpm pack:check  # Pack core/server/cli tarballs and verify isolated install + `cdeck serve`
```

## License

MIT — see [LICENSE](./LICENSE).
