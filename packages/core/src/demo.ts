import type { ContextDeckStore } from './store.js';

export async function seedDemoBoard(
  store: ContextDeckStore,
  slug = 'realtime-sync-v2',
): Promise<string> {
  const existing = await store.listBoards();
  if (existing.some((b) => b.slug === slug)) {
    return slug;
  }

  await store.createBoard(
    {
      title: 'Realtime Sync Engine v2',
      slug,
      description:
        'Cross-harness demo board showing hierarchical sessions, superseded decisions, staleness detection, Mermaid + Excalidraw diagrams, Kanban tasks, and quizzes.',
      brief: `# Realtime Sync Engine v2 — Living Mental Model

## Goal
Replace polling-based client sync with a low-latency local-first event stream that keeps multiple connected editors and AI coding agents aligned without external cloud infrastructure.

## Current Architecture Snapshot
- **Persistence:** Git-backed plain YAML/Markdown files per entity + append-only \`events.jsonl\`.
- **Transport:** Server-Sent Events (SSE) for real-time UI updates and Streamable HTTP + stdio for MCP agent harnesses.
- **State Authority:** Decisions (\`dec_*\`) act as the source of truth. Superseding a decision automatically flags dependent diagrams, videos, and quizzes as **stale** so human understanding stays accurate.

## Open Questions
1. Should binary video assets live in Git LFS or a local sidecar folder ignored by Git?
2. Do we want automatic transcript summarization hooks for Cursor in addition to Claude Code?
`,
      setAsDefault: existing.length === 0,
    },
    { type: 'human', label: 'maintainer' },
  );

  const rootSession = await store.registerSession(
    slug,
    {
      id: 'sess_arch_root',
      title: 'System Architecture & Tradeoffs',
      harness: 'cursor',
      externalRef: 'cursor://thread/arch-sync-v2',
      status: 'active',
      summary:
        'Designed initial storage model and real-time transport options. Needs to pull latest SQLite/SSE decision.',
      focusFiles: ['packages/core/src/store.ts', 'packages/server/src/app.ts'],
      lastSyncedRevision: 2,
    },
    { type: 'agent', harness: 'cursor', label: 'Cursor Composer' },
  );

  const claudeRefactor = await store.registerSession(
    slug,
    {
      id: 'sess_claude_storage',
      title: 'Refactor Storage to Git-Backed Files',
      harness: 'claude-code',
      parentSessionId: rootSession.id,
      status: 'active',
      summary:
        'Replaced Redis proposal with plain Git-backed files + append-only events.jsonl; recorded dec_003 superseding dec_001.',
      focusFiles: ['packages/core/src/store.ts', 'packages/core/src/drift.ts'],
    },
    { type: 'agent', harness: 'claude-code', label: 'Claude Code' },
  );

  const codexBench = await store.registerSession(
    slug,
    {
      id: 'sess_codex_bench',
      title: 'Benchmark SSE Fan-Out & File Watcher',
      harness: 'codex',
      parentSessionId: claudeRefactor.id,
      status: 'completed',
      summary: 'Verified <12ms local propagation with chokidar + SSE across 25 concurrent tabs.',
      focusFiles: ['packages/server/src/app.ts'],
    },
    { type: 'agent', harness: 'codex', label: 'Codex CLI' },
  );

  const grokResearch = await store.registerSession(
    slug,
    {
      id: 'sess_grok_research',
      title: 'Compare Drift Detection Patterns',
      harness: 'grok',
      parentSessionId: rootSession.id,
      relatedSessionIds: [claudeRefactor.id],
      status: 'paused',
      summary: 'Explored ADR dependency graphs and mental-model staleness indicators.',
      lastSyncedRevision: 4,
    },
    { type: 'agent', harness: 'grok', label: 'Grok Web' },
  );

  const dec1 = await store.recordDecision(
    slug,
    {
      id: 'dec_001',
      title: 'Use Local Redis Pub/Sub for Session State',
      status: 'accepted',
      sessionId: rootSession.id,
      tags: ['storage', 'infra'],
      summary: 'Initial prototype idea using Redis for real-time cross-session state.',
      rationale: 'Fast pub/sub primitives, though adds an external daemon dependency for contributors.',
    },
    { type: 'agent', harness: 'cursor', sessionId: rootSession.id },
  );

  const dec2 = await store.recordDecision(
    slug,
    {
      id: 'dec_002',
      title: 'Expose Universal MCP + REST/CLI Surface',
      status: 'accepted',
      sessionId: rootSession.id,
      tags: ['mcp', 'interoperability'],
      summary: 'Every harness connects via MCP (stdio/HTTP), CLI, or copyable Context Packs.',
      rationale:
        'Ensures Cursor, Claude Code, Codex, Grok, and custom local skills (like idea-to-video) all share one neutral board without runner lock-in.',
    },
    { type: 'agent', harness: 'cursor', sessionId: rootSession.id },
  );

  const dec3 = await store.recordDecision(
    slug,
    {
      id: 'dec_003',
      title: 'Use Git-Backed Plain Files + SSE Instead of Redis',
      status: 'accepted',
      supersedes: dec1.id,
      sessionId: claudeRefactor.id,
      tags: ['storage', 'local-first', 'git'],
      summary: 'Zero-daemon persistence using one file per entity + append-only events.jsonl + SSE.',
      rationale:
        'Eliminates Docker/Redis setup friction, gives native git diff/branching for free, and keeps parallel agent edits merge-friendly.',
    },
    { type: 'agent', harness: 'claude-code', sessionId: claudeRefactor.id },
  );

  // Diagram 1: Deliberately references dec_001 so users immediately see live Staleness Detection!
  await store.upsertDiagram(
    slug,
    {
      id: 'diag_sync_flow',
      title: 'Sync & Context Propagation Architecture',
      kind: 'mermaid',
      description: 'High-level flow showing how external agent harnesses synchronize through ContextDeck.',
      basedOnDecisions: [dec1.id, dec2.id],
      sessionId: rootSession.id,
      content: `flowchart LR
    Cursor["Cursor IDE (MCP)"] --> Server["ContextDeck Local Server"]
    Claude["Claude Code (MCP + Hooks)"] --> Server
    Grok["Grok / Web Chat (Context Pack)"] -.-> UI["ContextDeck Web App"]
    Skills["idea-to-video / Quiz Skills (CLI)"] --> Server
    Server --> Store["Redis Pub/Sub (OUTDATED - update to Git Store!)"]
    Server -->|SSE Live Push| UI
`,
    },
    { type: 'agent', harness: 'cursor', sessionId: rootSession.id },
  );

  // Diagram 2: Pre-populated Excalidraw whiteboard
  const excalidrawSample = {
    type: 'excalidraw',
    version: 2,
    source: 'contextdeck',
    elements: [
      {
        id: 'box-human',
        type: 'rectangle',
        x: 80,
        y: 120,
        width: 200,
        height: 80,
        strokeColor: '#38bdf8',
        backgroundColor: '#0c4a6e',
        fillStyle: 'solid',
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
        roundness: { type: 3 },
      },
      {
        id: 'txt-human',
        type: 'text',
        x: 112,
        y: 148,
        width: 140,
        height: 25,
        text: 'Human Mental Model',
        fontSize: 18,
        fontFamily: 1,
        textAlign: 'center',
        verticalAlign: 'middle',
        strokeColor: '#e0f2fe',
      },
      {
        id: 'box-board',
        type: 'rectangle',
        x: 360,
        y: 100,
        width: 240,
        height: 120,
        strokeColor: '#a78bfa',
        backgroundColor: '#3b0764',
        fillStyle: 'solid',
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
        roundness: { type: 3 },
      },
      {
        id: 'txt-board',
        type: 'text',
        x: 390,
        y: 145,
        width: 180,
        height: 30,
        text: 'ContextDeck (.contextdeck/)',
        fontSize: 18,
        fontFamily: 1,
        textAlign: 'center',
        verticalAlign: 'middle',
        strokeColor: '#f3e8ff',
      },
      {
        id: 'box-agents',
        type: 'rectangle',
        x: 680,
        y: 120,
        width: 220,
        height: 80,
        strokeColor: '#34d399',
        backgroundColor: '#064e3b',
        fillStyle: 'solid',
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
        roundness: { type: 3 },
      },
      {
        id: 'txt-agents',
        type: 'text',
        x: 705,
        y: 148,
        width: 170,
        height: 25,
        text: 'Cursor + Claude + Grok',
        fontSize: 18,
        fontFamily: 1,
        textAlign: 'center',
        verticalAlign: 'middle',
        strokeColor: '#d1fae5',
      },
    ],
    appState: {
      viewBackgroundColor: '#0f172a',
    },
  };

  await store.upsertDiagram(
    slug,
    {
      id: 'diag_mental_model_canvas',
      title: 'Mental Model Whiteboard (Excalidraw)',
      kind: 'excalidraw',
      description: 'Editable visual canvas shared between you and connected agents.',
      basedOnDecisions: [dec2.id, dec3.id],
      sessionId: claudeRefactor.id,
      content: JSON.stringify(excalidrawSample, null, 2),
    },
    { type: 'human', label: 'maintainer' },
  );

  // Tasks across Kanban columns
  await store.upsertTask(
    slug,
    {
      id: 'task_001',
      title: 'Implement Git-backed BoardStore & drift engine',
      column: 'done',
      priority: 'high',
      assignee: 'claude-code',
      linkedSessionIds: [claudeRefactor.id],
      linkedDecisionIds: [dec3.id],
      tags: ['core', 'storage'],
      description: 'Store sessions, decisions, tasks, diagrams, quizzes, and events as clean Git files.',
    },
    { type: 'agent', harness: 'claude-code', sessionId: claudeRefactor.id },
  );

  await store.upsertTask(
    slug,
    {
      id: 'task_002',
      title: 'Update Sync Architecture diagram to remove Redis node',
      column: 'in_progress',
      priority: 'high',
      assignee: 'cursor',
      linkedSessionIds: [rootSession.id],
      linkedDecisionIds: [dec1.id],
      tags: ['docs', 'diagram'],
      description: 'Diagram diag_sync_flow still shows Redis from dec_001. Refresh to match dec_003.',
    },
    { type: 'human', label: 'maintainer' },
  );

  await store.upsertTask(
    slug,
    {
      id: 'task_003',
      title: 'Wire idea-to-video skill CLI hook to attach .mp4 explainers',
      column: 'backlog',
      priority: 'medium',
      assignee: 'human',
      linkedSessionIds: [grokResearch.id],
      linkedDecisionIds: [dec2.id],
      tags: ['skills', 'video', 'kokoro-tts'],
      description:
        'At the end of an idea-to-video run, call `cdeck media add --type video --file out.mp4 --transcript ... --based-on dec_003`.',
    },
    { type: 'human', label: 'maintainer' },
  );

  await store.upsertTask(
    slug,
    {
      id: 'task_004',
      title: 'Review SSE latency benchmark report from Codex',
      column: 'in_review',
      priority: 'medium',
      assignee: 'human',
      linkedSessionIds: [codexBench.id],
      linkedDecisionIds: [dec3.id],
      tags: ['performance'],
      description: 'Confirm debounced file watcher stays responsive under rapid multi-agent edits.',
    },
    { type: 'agent', harness: 'codex', sessionId: codexBench.id },
  );

  // Media artifacts: Reference doc + Explainer Script / Video placeholder with transcript & chapters
  await store.addMedia(
    slug,
    {
      id: 'art_handoff_playbook',
      title: 'Multi-Harness Handoff Playbook',
      kind: 'doc',
      tags: ['playbook', 'onboarding'],
      basedOnDecisions: [dec2.id, dec3.id],
      sessionId: claudeRefactor.id,
      content: `# Multi-Harness Handoff Playbook

When jumping between **Cursor**, **Claude Code**, **Codex**, and **Grok**:

1. **Before starting a new thread:** Let your agent call \`board_get_brief\` (via MCP) or click **Copy Context Pack** for web chats.
2. **When direction changes:** Record a Decision (\`decision_record\`) with \`supersedes: "dec_xxx"\`. ContextDeck automatically flags outdated diagrams, videos, and quizzes.
3. **To verify your own mental model:** Generate a quick 3–5 question quiz in the **Media & Mastery** tab and check your score!
`,
    },
    { type: 'agent', harness: 'claude-code', sessionId: claudeRefactor.id },
  );

  await store.addMedia(
    slug,
    {
      id: 'art_kokoro_explainer_note',
      title: 'Concept Explainer: Why Supersession Beats Static Docs (Attach Your .mp4 Here)',
      kind: 'video',
      tags: ['explainer', 'kokoro-tts', 'idea-to-video'],
      basedOnDecisions: [dec1.id],
      sessionId: grokResearch.id,
      durationSec: 95,
      chapters: [
        { timeSec: 0, title: 'The Multi-Thread Amnesia Problem' },
        { timeSec: 32, title: 'Decisions as Versioned Anchors' },
        { timeSec: 68, title: 'Automatic Staleness Propagation' },
      ],
      transcript:
        'Welcome! When you run five parallel agent chats across Cursor and Claude Code, the hardest failure mode is silent drift: one thread changes the architecture while your mental model—and your other chats—still assume the old design. By linking every diagram, video explainer, and quiz to specific Decision IDs, ContextDeck tells you the exact moment an artifact goes stale. (Drop any local .mp4/.webm from your idea-to-video skill via the Upload button or `cdeck media add --type video --file ...` to play it right here!)',
    },
    { type: 'agent', harness: 'skill', label: 'idea-to-video' },
  );

  // Interactive Knowledge Check Quiz
  const quiz = await store.createQuiz(
    slug,
    {
      id: 'quiz_sync_mastery',
      title: 'Mental Model Check: Realtime Sync Engine v2',
      topic: 'Architecture & Drift Detection',
      description: 'Verify your understanding of the latest storage, transport, and staleness decisions.',
      basedOnDecisions: [dec2.id, dec3.id],
      sessionId: grokResearch.id,
      questions: [
        {
          id: 'q1',
          prompt: 'Which persistence layer did dec_003 adopt to replace the earlier Redis Pub/Sub proposal?',
          type: 'multiple_choice',
          options: [
            'Managed Postgres with pgvector',
            'Git-backed plain YAML/Markdown files + append-only events.jsonl',
            'Browser IndexedDB synced via WebRTC',
            'In-memory Redis Cluster',
          ],
          correctIndex: 1,
          explanation:
            'dec_003 superseded dec_001 to eliminate external daemon dependencies and make every context update git-diffable and merge-friendly.',
          relatedDecisionIds: [dec3.id],
        },
        {
          id: 'q2',
          prompt: 'What happens automatically when a new Decision supersedes an older Decision ID?',
          type: 'multiple_choice',
          options: [
            'Old diagrams and videos are permanently deleted',
            'Artifacts referencing the old Decision are flagged as Stale, and behind Sessions show revision lag',
            'Nothing until you manually edit every Markdown file',
            'All connected agents are immediately terminated',
          ],
          correctIndex: 1,
          explanation:
            'ContextDeck preserves history while surfacing exact staleness reasons on dependent artifacts and missed events on drifted sessions.',
          relatedDecisionIds: [dec3.id],
        },
        {
          id: 'q3',
          prompt: 'How can a web-only harness like Grok (without local MCP support) stay synced with a board?',
          type: 'multiple_choice',
          options: [
            'It cannot connect at all',
            'By copying the 1-click Context Pack into chat and pasting back its structured JSON update',
            'By installing a browser kernel driver',
            'Only by committing directly to GitHub',
          ],
          correctIndex: 1,
          explanation:
            'Context Packs + Paste Update let zero-tool web chats read the current mental model and contribute decisions, tasks, and summaries back.',
          relatedDecisionIds: [dec2.id],
        },
      ],
    },
    { type: 'agent', harness: 'skill', label: 'quiz-generator' },
  );

  await store.submitQuizAttempt(
    slug,
    quiz.id,
    {
      answers: { q1: 1, q2: 1, q3: 0 },
      confidence: 4,
    },
    { type: 'human', label: 'maintainer' },
  );

  // Backdate Cursor & Grok sessions' lastSyncedRevision slightly so Session Drift UI is immediately demonstrable
  await store.updateSession(
    slug,
    rootSession.id,
    { lastSyncedRevision: 3 },
    { type: 'system', label: 'demo-seed' },
  );
  await store.updateSession(
    slug,
    grokResearch.id,
    { lastSyncedRevision: 5 },
    { type: 'system', label: 'demo-seed' },
  );

  return slug;
}
