# Agent Guidelines

<!-- contextdeck:start -->
## Shared Context Protocol (ContextDeck)

This repository dogfoods **ContextDeck** in `.contextdeck/`.
Whenever you work in this repository (from Cursor, Claude Code, Codex, or any other harness):

1. **Orient first:** Call the `board_get_brief` MCP tool (or run `cdeck brief --pack`) to load the current mental model, active decisions, and open tasks.
2. **Register your session:** Call `session_register` (linking `parentSessionId` if continuing a parent thread) so your session appears in the Session Hierarchy graph.
3. **Record decisions & supersessions:** When architecture or direction changes, call `decision_record` (passing `supersedes: "dec_xxx"` when replacing an older choice) so outdated diagrams, videos, and quizzes are flagged stale.
4. **Update living artifacts:** Keep Kanban tasks (`task_upsert`), Mermaid/Excalidraw diagrams (`diagram_upsert`), reference media (`media_attach`), and knowledge-check quizzes (`quiz_create`) current.
<!-- contextdeck:end -->
