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

### Claude Code
```bash
cdeck setup claude-code
```
Writes `.mcp.json` (stdio MCP server) and a lightweight `SessionStart` hook in `.claude/settings.local.json` that alerts Claude Code of the current board revision and drift state.

### Cursor
```bash
cdeck setup cursor
```
Writes `.cursor/mcp.json` and `.cursor/rules/contextdeck.mdc` so every Cursor chat automatically orients from and updates the active board.

### Codex CLI
```bash
cdeck setup codex
```
Generates a ready-to-paste MCP server block (both stdio and Streamable HTTP options) for `~/.codex/config.toml`.

### Universal (`AGENTS.md`)
```bash
cdeck setup agents-md
```
Injects a clean protocol section into `AGENTS.md` for any coding agent that reads repository instructions.

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
