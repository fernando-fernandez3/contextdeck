# Realtime Sync Engine v2 — Living Mental Model

## Goal
Replace polling-based client sync with a low-latency local-first event stream that keeps multiple connected editors and AI coding agents aligned without external cloud infrastructure.

## Current Architecture Snapshot
- **Persistence:** Git-backed plain YAML/Markdown files per entity + append-only `events.jsonl`.
- **Transport:** Server-Sent Events (SSE) for real-time UI updates and Streamable HTTP + stdio for MCP agent harnesses.
- **State Authority:** Decisions (`dec_*`) act as the source of truth. Superseding a decision automatically flags dependent diagrams, videos, and quizzes as **stale** so human understanding stays accurate.

## Open Questions
1. Should binary video assets live in Git LFS or a local sidecar folder ignored by Git?
2. Do we want automatic transcript summarization hooks for Cursor in addition to Claude Code?
