import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  BoardSlugSchema,
  ConflictError,
  ContextDeckStore,
  DecisionStatusSchema,
  DiagramKindSchema,
  EntityIdSchema,
  HttpUrlSchema,
  MediaChapterSchema,
  MediaKindSchema,
  QuizQuestionSchema,
  SessionStatusSchema,
  TaskColumnSchema,
  TaskPrioritySchema,
  generateContextPack,
  type WatchOptions,
} from '@contextdeck/core';
import { validateMcpMediaSourcePath } from './security.js';

const MCP_MAX_BRIEF_CHARS = 200 * 1024; // 200 KB (E2 amended)
const MCP_MAX_TEXT_CHARS = 20 * 1024; // 20 KB (E2 amended)
const SUBSCRIBABLE_RESOURCE_URIS = new Set(['contextdeck://brief', 'contextdeck://snapshot']);
const subscribedUrisByServer = new WeakMap<McpServer, Set<string>>();

export interface CreateMcpServerOptions {
  defaultBoard?: string;
  onMutate?: (boardSlug: string) => void;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  maxMediaBytes?: number;
}

export function createContextDeckMcpServer(
  store: ContextDeckStore,
  defaultBoardOrOptions?: string | CreateMcpServerOptions,
  onMutateLegacy?: (boardSlug: string) => void,
): McpServer {
  const options: CreateMcpServerOptions =
    typeof defaultBoardOrOptions === 'string' || defaultBoardOrOptions === undefined
      ? { defaultBoard: defaultBoardOrOptions, onMutate: onMutateLegacy }
      : defaultBoardOrOptions;

  const { defaultBoard, onMutate, env, homeDir } = options;
  const maxMediaBytes = options.maxMediaBytes ?? store.maxMediaBytes;

  const server = new McpServer(
    {
      name: 'contextdeck',
      version: '0.2.0',
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
      },
    },
  );

  const subscribedUris = new Set<string>();
  subscribedUrisByServer.set(server, subscribedUris);

  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (!SUBSCRIBABLE_RESOURCE_URIS.has(uri)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown subscribable resource URI: ${uri}`);
    }
    subscribedUris.add(uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribedUris.delete(req.params.uri);
    return {};
  });

  // D4 / D9 / AC6.1: Never auto-initialize a workspace. Default to the session's bound board when sessionId is passed.
  const resolveSlug = async (board?: string, sessionId?: string | null) => {
    if (board !== undefined && board !== '') {
      return store.resolveBoardSlug(board);
    }
    if (sessionId) {
      const session = await store.getSession(sessionId);
      if (session?.board) {
        return store.resolveBoardSlug(session.board);
      }
    }
    return store.resolveBoardSlug(defaultBoard);
  };

  server.registerTool(
    'board_list',
    {
      title: 'List ContextDeck Boards',
      description: 'List all shared context boards in this workspace.',
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const boards = await store.listBoards();
      const def = boards.length > 0 ? await store.getDefaultBoardSlug() : null;
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
        'Retrieve the compact, up-to-date shared mental model (brief, active decisions, open tasks, linked sessions, and stale artifact warnings). Pass sessionId to mark your session synced to the exact revision returned.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional().describe('Optional board slug; defaults to active board'),
          sessionId: EntityIdSchema.optional().describe(
            'Optional session ID to mark synced to the revision returned',
          ),
          maxChars: z.number().int().min(500).max(100_000).optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, maxChars }) => {
      const slug = await resolveSlug(board, sessionId);
      // D7: Read snapshot FIRST, then acknowledge exact snapshot.config.revision!
      const snapshot = await store.getSnapshot(slug);
      let missedSummary = '';
      if (sessionId) {
        try {
          const synced = await store.syncSession(slug, sessionId, {
            ackRevision: snapshot.config.revision,
          });
          if (synced.digest.length > 0 && synced.digestText) {
            missedSummary = `\n\n### Missed Updates Synced for ${sessionId}\n${synced.digestText}\n`;
          }
          onMutate?.(slug);
        } catch {
          // session may not exist yet; still return the brief
        }
      }
      const pack = generateContextPack(snapshot, {
        includeUpdateProtocol: false,
        maxChars,
      });
      return {
        content: [{ type: 'text', text: pack + missedSummary }],
      };
    },
  );

  server.registerTool(
    'board_update_brief',
    {
      title: 'Update Living Brief',
      description:
        'Update the shared Markdown mental-model brief for the board. REQUIRES `baseRevision` taken from your most recent `board_get_brief` response so concurrent edits are never silently overwritten.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          brief: z.string().min(1).max(MCP_MAX_BRIEF_CHARS).describe('Full updated Markdown brief'),
          baseRevision: z
            .number()
            .int()
            .min(1)
            .describe('Board revision from your latest board_get_brief call (required for optimistic concurrency)'),
          harness: z.string().max(100).optional(),
          sessionId: EntityIdSchema.optional(),
        })
        .strict(),
    },
    async ({ board, brief, baseRevision, harness, sessionId }) => {
      const slug = await resolveSlug(board, sessionId);
      try {
        const res = await store.updateBrief(
          slug,
          brief,
          {
            type: 'agent',
            harness: harness ?? 'mcp',
            sessionId,
          },
          { baseRevision },
        );
        onMutate?.(slug);
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        };
      } catch (err) {
        if (err instanceof ConflictError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: err.message,
                    code: err.code,
                    ...err.details,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'board_check_drift',
    {
      title: 'Check Session Drift & Stale Artifacts',
      description:
        'Check which artifacts (diagrams, videos, quizzes, tasks) are stale due to superseded decisions, and which active agent sessions are behind the latest board revision.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema.optional(),
        })
        .strict(),
    },
    async ({ board, sessionId }) => {
      const slug = await resolveSlug(board, sessionId);
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          id: EntityIdSchema.optional(),
          title: z.string().min(1).max(300),
          harness: z.string().max(100).default('mcp'),
          parentSessionId: EntityIdSchema.nullable().optional(),
          relatedSessionIds: z.array(EntityIdSchema).max(100).optional(),
          externalRef: z.string().max(500).optional(),
          summary: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          focusFiles: z.array(z.string().max(500)).max(200).optional(),
        })
        .strict(),
    },
    async ({ board, ...input }) => {
      // H9: When board is omitted and an existing session matches externalRef or id, keep existing.board
      let targetBoard = board;
      if (targetBoard === undefined) {
        if (input.externalRef) {
          const existing = await store.findSessionByExternalRef(input.externalRef);
          if (existing?.board) targetBoard = existing.board;
        } else if (input.id) {
          const existing = await store.getSession(input.id);
          if (existing?.board) targetBoard = existing.board;
        }
      }
      const slug = await resolveSlug(targetBoard);
      const session = await store.registerSession(slug, input, {
        type: 'agent',
        harness: input.harness,
      });
      onMutate?.(session.board ?? slug);
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema,
          title: z.string().min(1).max(300).optional(),
          status: SessionStatusSchema.optional(),
          summary: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          parentSessionId: EntityIdSchema.nullable().optional(),
          relatedSessionIds: z.array(EntityIdSchema).max(100).optional(),
          focusFiles: z.array(z.string().max(500)).max(200).optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, ...patch }) => {
      const slug = await resolveSlug(board, sessionId);
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          title: z.string().min(1).max(300),
          summary: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          rationale: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          status: DecisionStatusSchema.optional(),
          supersedes: EntityIdSchema.nullable().optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          harness: z.string().max(100).optional(),
          tags: z.array(z.string().max(100)).max(50).optional(),
        })
        .strict(),
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board, input.sessionId);
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          id: EntityIdSchema.optional(),
          title: z.string().min(1).max(300),
          column: TaskColumnSchema.optional(),
          priority: TaskPrioritySchema.optional(),
          assignee: z.string().max(120).optional(),
          description: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          linkedSessionIds: z.array(EntityIdSchema).max(100).optional(),
          linkedDecisionIds: z.array(EntityIdSchema).max(100).optional(),
          tags: z.array(z.string().max(100)).max(50).optional(),
          harness: z.string().max(100).optional(),
          sessionId: EntityIdSchema.optional(),
        })
        .strict(),
    },
    async ({ board, harness, sessionId, ...input }) => {
      const slug = await resolveSlug(board, sessionId);
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          id: EntityIdSchema.optional(),
          title: z.string().min(1).max(300),
          kind: DiagramKindSchema.default('mermaid'),
          content: z.string().min(1).max(MCP_MAX_TEXT_CHARS),
          description: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board, input.sessionId);
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
        'Attach an explainer video (.mp4/.webm), audio clip, Markdown doc, URL, HTML widget, or custom JSON artifact to the Media & Mastery lens. Local sourceFilePath imports are restricted to regular non-hidden, non-secret files inside the project root or user-local ~/.contextdeck/config.yaml mediaRoots.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          title: z.string().min(1).max(300),
          kind: MediaKindSchema,
          sourceFilePath: z
            .string()
            .max(1024)
            .optional()
            .describe('Local file path inside projectRoot or user-local mediaRoots'),
          externalUrl: HttpUrlSchema.optional(),
          content: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          transcript: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          chapters: z.array(MediaChapterSchema).max(200).optional(),
          durationSec: z.number().nonnegative().optional(),
          tags: z.array(z.string().max(100)).max(50).optional(),
          basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, harness, sourceFilePath, ...input }) => {
      const slug = await resolveSlug(board, input.sessionId);
      let safeSourcePath: string | undefined;
      if (sourceFilePath !== undefined) {
        safeSourcePath = await validateMcpMediaSourcePath(sourceFilePath, {
          projectRoot: store.projectRoot,
          deckDir: store.deckDir,
          maxMediaBytes,
          env,
          homeDir,
        });
      }
      const media = await store.addMedia(
        slug,
        {
          ...input,
          sourceFilePath: safeSourcePath,
          maxBytes: maxMediaBytes,
        },
        {
          type: 'agent',
          harness: harness ?? 'mcp',
          sessionId: input.sessionId ?? undefined,
        },
      );
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          title: z.string().min(1).max(300),
          topic: z.string().max(300).optional(),
          description: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          questions: z.array(QuizQuestionSchema).min(1).max(100),
          basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, harness, ...input }) => {
      const slug = await resolveSlug(board, input.sessionId);
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
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          artifactType: z.enum(['diagram', 'media', 'quiz', 'task']),
          artifactId: EntityIdSchema,
          harness: z.string().max(100).optional(),
          sessionId: EntityIdSchema.optional(),
        })
        .strict(),
    },
    async ({ board, artifactType, artifactId, harness, sessionId }) => {
      const slug = await resolveSlug(board, sessionId);
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

/**
 * Attach a scoped board-config file watcher (D10: `boards/<slug>/board.yaml`, depth 2)
 * that emits `notifications/resources/updated` for every subscribed URI on board change (AC5.8).
 */
export function attachMcpResourceWatcher(
  server: McpServer,
  store: ContextDeckStore,
  options: Omit<WatchOptions, 'scope'> = {},
) {
  if (!store.isInitialized()) return null;
  const subscribedUris = subscribedUrisByServer.get(server);

  return store.watch(
    () => {
      if (!subscribedUris || subscribedUris.size === 0) return;
      for (const uri of subscribedUris) {
        void server.server.sendResourceUpdated({ uri }).catch(() => {});
      }
    },
    { ...options, scope: 'board-configs' },
  );
}

export async function startStdioMcpServer(
  store: ContextDeckStore,
  defaultBoard?: string,
): Promise<void> {
  const server = createContextDeckMcpServer(store, { defaultBoard });
  const transport = new StdioServerTransport();

  // D10 / AC5.8: MCP stdio watches only boards/*/board.yaml (depth 2) and notifies subscribers
  const watcher = attachMcpResourceWatcher(server, store);

  transport.onclose = () => {
    if (watcher) {
      void watcher.close();
    }
  };

  await server.connect(transport);
}
