# Multi-Harness Handoff Playbook

When jumping between **Cursor**, **Claude Code**, **Codex**, and **Grok**:

1. **Before starting a new thread:** Let your agent call `board_get_brief` (via MCP) or click **Copy Context Pack** for web chats.
2. **When direction changes:** Record a Decision (`decision_record`) with `supersedes: "dec_xxx"`. ContextDeck automatically flags outdated diagrams, videos, and quizzes.
3. **To verify your own mental model:** Generate a quick 3–5 question quiz in the **Media & Mastery** tab and check your score!
