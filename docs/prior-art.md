# Prior art

ContextDeck started from a simple question: does anything already give several AI agent sessions, across
different harnesses, one shared and continuously updated context that a human can also browse and learn from?
We looked in November 2026. Pieces exist; the combination did not.

| Project | What it does well | What it does not do |
| --- | --- | --- |
| [Backlog.md](https://github.com/MrLesk/Backlog.md) | Markdown tasks, docs and decisions in git, a local web Kanban, MCP for Claude Code, Codex, Gemini CLI, Kiro and Cursor. | No session hierarchy, no diagrams/media/quizzes, no notion of artifacts going stale when a decision changes. |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Captures sessions automatically through harness hooks (Claude Code, Codex, Cursor, Gemini, Grok Bot and more) and injects relevant memory into later sessions; web viewer. | Searchable memory rather than a curated board; no decision ledger, lenses or learning artifacts. |
| [Beads](https://github.com/gastownhall/beads) | Git/Dolt-backed dependency graph of issues built for many concurrent agent writers. | Tasks only; no human-facing mental model, media or quizzes. |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | Shared Markdown knowledge base across Claude, ChatGPT, Codex and Cursor over MCP. | Notes and a knowledge graph; no sessions, decisions or staleness. |
| [shared-context-mcp](https://github.com/xfajarr/shared-context-mcp) | Named shared contexts with real-time push to connected agents (MCP resource notifications and WebSocket). | Agent-to-agent only, no UI, very early. |
| [Agent Hub MCP](https://github.com/gilbarbara/agent-hub-mcp) | Messaging and coordination between agents on different platforms. | Coordination channel, not a shared mental model. |
| [SpecStory](https://docs.specstory.com/integrations/claude-code) | Saves Cursor, Claude Code, Codex and other agent conversations as local Markdown. | An archive of past chats, not live shared context. |

## Where ContextDeck is different

- **Decisions are versioned anchors.** When a decision is superseded, every diagram, explainer video, quiz and open
  task built on the old one is flagged as out of date, and a refresh can be queued for an agent or a local worker.
- **The human is a first-class reader.** ContextDeck tracks what you have and have not seen and shows exactly what
  changed since you last looked, alongside the agents' own sync state.
- **Live sessions get the news.** Hooks for Claude Code, Codex and Cursor inject what changed into a running session
  instead of waiting for the agent to re-read the board.
- **Any harness, plain files.** MCP (stdio and Streamable HTTP), a CLI, and copy/paste Context Packs for web chats,
  all over plain YAML/Markdown/JSON files you can commit or keep outside the repo.
