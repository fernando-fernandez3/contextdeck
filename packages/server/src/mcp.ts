import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ContextDeckStore,
  DecisionStatusSchema,
  DiagramKindSchema,
  MediaKindSchema,
  QuizQuestionSchema,
  SessionStatusSchema,
  TaskColumnSchema,
  TaskPrioritySchema,
  generateContextPack,
} from '@contextdeck/core';

export function createContextDeckMcpServer(
  store: ContextDeckStore,
  defaultBoard?: string,
  onMutate?: (boardSlug: string) => void,
): McpServer {
  const server = new McpServer({
    name: 'contextdeck',
    version: '0.1.0',
  });

  const resolveSlug = async (board?: string) => {
    await store.ensureDefaultBoard();
    return store.resolveBoardSlug(board ?? defaultBoard);
  };

  server.registerTool(
    'board_list',
    {
      title: 'List ContextDeck Boards',
      description: 'List all shared context boards in this workspace.',
      inputSchema: {},
    },
    async () => {
      await store.ensureDefaultBoard();
      const boards = await store.listBoards();
      const def = await store.getDefaultBoardSlug();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ defaultBoard: def, boards }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'board_get_brief',
    {
      title: 'Get Shared Context Brief',
      description:
        'Retrieve the compact, up-to-date shared mental model (brief, active decisions, open tasks, linked sessions, and stale artifact warnings). Pass sessionId to automatically mark your session synced to the latest revision.',
      inputSchema: {
        board: z.string().optional().describe('Optional board slug; defaults to active board'),
        sessionId: z
          .string()
          .optional()
          .describe('Optional session ID to mark synced to the latest revision'),
      },
    },
    async ({ board, sessionId }) => {
      const slug = await resolveSlug(board);
      let missedSummary = '';
      if (sessionId) {
        try {
          const synced = await store.syncSession(slug, sessionId);
          if (synced.missedEvents.length > 0) {
            missedSummary = `\n\n### Missed Updates Synced for ${sessionId}\n${synced.missedEvents
              .map((e) => `- rev ${e.revision} (${e.kind}): ${e.summary}`)
              .join('\n')}\n`;
          }
          onMutate?.(slug);
        } catch {
          // session may not exist yet; proceed with brief
        }
      }
      const snapshot = await store.getSnapshot(slug);
      const pack = generateContextPack(snapshot, { includeUpdateProtocol: false });
      return {
        content: [{ type: 'text', text: pack + missedSummary }],
      };
    },
  );

  server.registerTool(
    'board_update_brief',
    {
      title: 'Update Living Brief',
      description: 'Update the shared Markdown mental-model brief for the board.',
      inputSchema: {
        board: z.string().optional(),
        brief: z.string().min(1).describe('Full updated Markdown brief'),
        harness: z.string().optional(),
        sessionId: z.string().optional(),
      },
    },
    async ({ board, brief, harness, sessionId }) => {
      const slug = await resolveSlug(board);
      const res = await store.updateBrief(slug, brief, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
      };
    },
  );

  server.registerTool(
    'board_check_drift',
    {
      title: 'Check Session Drift & Stale Artifacts',
      description:
        'Check which artifacts (diagrams, videos, quizzes, tasks) are stale due to superseded decisions, and which agent sessions are behind the latest board revision.',
      inputSchema: {
        board: z.string().optional(),
      },
    },
    async ({ board }) => {
      const slug = await resolveSlug(board);
      const snapshot = await store.getSnapshot(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(snapshot.drift, null, 2) }],
      };
    },
  );

  server.registerTool(
    'session_register',
    {
      title: 'Register Agent Session',
      description:
        'Register this agent session on the shared board, optionally linking it under a parentSessionId to form a hierarchical session tree across harnesses.',
      inputSchema: {
        board: z.string().optional(),
        id: z.string().optional(),
        title: z.string().min(1),
        harness: z.string().default('mcp'),
        parentSessionId: z.string().nullable().optional(),
        relatedSessionIds: z.array(z.string()).optional(),
        externalRef: z.string().optional(),
        summary: z.string().optional(),
        focusFiles: z.array(z.string()).optional(),
      },
    },
    async ({ board, ...input }) => {
      const slug = await resolveSlug(board);
      const session = await store.registerSession(slug, input, {
        type: 'agent',
        harness: input.harness,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(session, null, 2) }],
      };
    },
  );

  server.registerTool(
    'session_update',
    {
      title: 'Update Agent Session',
      description: 'Update summary, status, focus files, or parent/sibling links for a session.',
      inputSchema: {
        board: z.string().optional(),
        sessionId: z.string().min(1),
        title: z.string().optional(),
        status: SessionStatusSchema.optional(),
        summary: z.string().optional(),
        parentSessionId: z.string().nullable().optional(),
        relatedSessionIds: z.array(z.string()).optional(),
        focusFiles: z.array(z.string()).optional(),
      },
    },
    async ({ board, sessionId, ...patch }) => {
      const slug = await resolveSlug(board);
      const updated = await store.updateSession(slug, sessionId, patch, {
        type: 'agent',
        sessionId,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  server.registerTool(
    'decision_record',
    {
      title: 'Record Architectural / Project Decision',
      description:
        'Record a new decision on the board. If `supersedes` is provided, the older decision is marked superseded and all dependent diagrams/videos/quizzes are automatically flagged stale.',
      inputSchema: {
        board: z.string().optional(),
        title: z.string().min(1),
        summary: z.string().optional(),
        rationale: z.string().optional(),
        status: DecisionStatusSchema.optional(),
        supersedes: z.string().nullable().optional(),
        sessionId: z.string().nullable().optional(),
        harness: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board);
      const decision = await store.recordDecision(slug, input, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId: input.sessionId ?? undefined,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
      };
    },
  );

  server.registerTool(
    'task_upsert',
    {
      title: 'Create or Update Kanban Task',
      description: 'Add a new task or update an existing task column, priority, or decision links.',
      inputSchema: {
        board: z.string().optional(),
        id: z.string().optional(),
        title: z.string().min(1),
        column: TaskColumnSchema.optional(),
        priority: TaskPrioritySchema.optional(),
        assignee: z.string().optional(),
        description: z.string().optional(),
        linkedSessionIds: z.array(z.string()).optional(),
        linkedDecisionIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        harness: z.string().optional(),
        sessionId: z.string().optional(),
      },
    },
    async ({ board, harness, sessionId, ...input }) => {
      const slug = await resolveSlug(board);
      const task = await store.upsertTask(slug, input, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    },
  );

  server.registerTool(
    'diagram_upsert',
    {
      title: 'Create or Update Visual Diagram',
      description:
        'Create or update a Mermaid or Excalidraw diagram on the Architecture & Canvas lens.',
      inputSchema: {
        board: z.string().optional(),
        id: z.string().optional(),
        title: z.string().min(1),
        kind: DiagramKindSchema.default('mermaid'),
        content: z.string().min(1),
        description: z.string().optional(),
        basedOnDecisions: z.array(z.string()).optional(),
        sessionId: z.string().nullable().optional(),
        harness: z.string().optional(),
      },
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board);
      const diagram = await store.upsertDiagram(slug, input, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId: input.sessionId ?? undefined,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(diagram, null, 2) }],
      };
    },
  );

  server.registerTool(
    'media_attach',
    {
      title: 'Attach Media, Video, or Reference Doc',
      description:
        'Attach an explainer video (.mp4/.webm), audio clip, Markdown doc, URL, HTML widget, or custom JSON artifact to the Media & Mastery lens.',
      inputSchema: {
        board: z.string().optional(),
        title: z.string().min(1),
        kind: MediaKindSchema,
        sourceFilePath: z
          .string()
          .optional()
          .describe('Local file path to copy into board media storage'),
        externalUrl: z.string().optional(),
        content: z.string().optional(),
        transcript: z.string().optional(),
        chapters: z
          .array(z.object({ timeSec: z.number().nonnegative(), title: z.string() }))
          .optional(),
        durationSec: z.number().nonnegative().optional(),
        tags: z.array(z.string()).optional(),
        basedOnDecisions: z.array(z.string()).optional(),
        sessionId: z.string().nullable().optional(),
        harness: z.string().optional(),
      },
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board);
      const media = await store.addMedia(slug, input, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId: input.sessionId ?? undefined,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(media, null, 2) }],
      };
    },
  );

  server.registerTool(
    'quiz_create',
    {
      title: 'Create Interactive Knowledge-Check Quiz',
      description:
        'Publish an interactive quiz onto the Media & Mastery lens so the human can test their mental model and track mastery.',
      inputSchema: {
        board: z.string().optional(),
        title: z.string().min(1),
        topic: z.string().optional(),
        description: z.string().optional(),
        questions: z.array(QuizQuestionSchema).min(1),
        basedOnDecisions: z.array(z.string()).optional(),
        sessionId: z.string().nullable().optional(),
        harness: z.string().optional(),
      },
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board);
      const quiz = await store.createQuiz(slug, input, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId: input.sessionId ?? undefined,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(quiz, null, 2) }],
      };
    },
  );

  server.registerTool(
    'artifact_refresh',
    {
      title: 'Mark Stale Artifact Aligned',
      description:
        'After updating a stale diagram, video, quiz, or task to reflect newer decisions, call this to realign its decision references and clear staleness alerts.',
      inputSchema: {
        board: z.string().optional(),
        artifactType: z.enum(['diagram', 'media', 'quiz', 'task']),
        artifactId: z.string().min(1),
        harness: z.string().optional(),
        sessionId: z.string().optional(),
      },
    },
    async ({ board, artifactType, artifactId, harness, sessionId }) => {
      const slug = await resolveSlug(board);
      await store.refreshArtifactDecisions(slug, artifactType, artifactId, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId,
      });
      onMutate?.(slug);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ refreshed: true, artifactType, artifactId }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'context-brief',
    'contextdeck://brief',
    {
      title: 'Current ContextDeck Brief',
      description: 'Live Markdown context pack for the active ContextDeck board.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const slug = await resolveSlug();
      const snapshot = await store.getSnapshot(slug);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: generateContextPack(snapshot, { includeUpdateProtocol: false }),
          },
        ],
      };
    },
  );

  server.registerResource(
    'context-snapshot',
    'contextdeck://snapshot',
    {
      title: 'Full Board Snapshot JSON',
      description: 'Complete JSON snapshot including drift & staleness report.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const slug = await resolveSlug();
      const snapshot = await store.getSnapshot(slug);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

export async function startStdioMcpServer(
  store: ContextDeckStore,
  defaultBoard?: string,
): Promise<void> {
  const server = createContextDeckMcpServer(store, defaultBoard);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
