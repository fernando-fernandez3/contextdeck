# Agent Guidelines

<!-- contextdeck:start -->
## Shared Context Protocol (ContextDeck)

This project maintains a shared context board via **ContextDeck** (`.contextdeck/` or `.contextdeck.yaml`).
Whenever you work in this repository (from Claude Code, Codex, Cursor, Grok, Antigravity, or any other harness):

1. **Reuse your injected session ID:** If a ContextDeck hook injected `Your ContextDeck session id is sess_xxx`, reuse that `sessionId` on every ContextDeck MCP tool call and **do NOT call `session_register`**. Only call `session_register` if no session ID was injected (pass a stable `externalRef` when available and `parentSessionId` when branching from a parent thread).
2. **Orient & stay synced:** If you did not receive a startup context pack, call `board_get_brief` (passing `sessionId` when known) or run `cdeck brief --pack`. When a hook injects a ContextDeck update digest, align your work with the newer decisions before editing.
3. **Record decisions & supersessions:** Whenever architecture or product direction changes, call `decision_record` (passing `sessionId`, and `supersedes: "dec_xxx"` when replacing an older decision) so other live sessions receive the change and dependent diagrams, media, and quizzes are flagged stale.
4. **Update living artifacts:** Pass `sessionId` on `task_upsert`, `diagram_upsert`, `media_attach`, `quiz_create`, and `board_update_brief` (with `baseRevision` from `board_get_brief`) so edits route to your bound board and never trigger self-drift.
<!-- contextdeck:end -->
