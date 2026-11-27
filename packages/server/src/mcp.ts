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
  RefreshJobArtifactTypeSchema,
  RefreshJobStatusSchema,
  SessionStatusSchema,
  TaskColumnSchema,
  TaskPrioritySchema,
  generateContextPack,
  redactJobLease,
  redactJobsLeases,
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
  enableResourceSubscriptions?: boolean;
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
  const enableResourceSubscriptions = options.enableResourceSubscriptions ?? true;

  const server = new McpServer(
    {
      name: 'contextdeck',
      version: '0.2.0',
    },
    {
      capabilities: {
        resources: enableResourceSubscriptions
          ? {
              subscribe: true,
              listChanged: true,
            }
          : {
              listChanged: true,
            },
      },
    },
  );

  if (enableResourceSubscriptions) {
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
  }

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
          harness: z.string().max(100).optional(),
          parentSessionId: EntityIdSchema.nullable().optional(),
          relatedSessionIds: z.array(EntityIdSchema).max(100).optional(),
          externalRef: z.string().max(500).optional(),
          summary: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          focusFiles: z.array(z.string().max(500)).max(200).optional(),
        })
        .strict(),
    },
    async ({ board, ...input }) => {
      // H9 / R3-2: When board is omitted and an existing session matches externalRef or id, keep existing.board
      let targetBoard = board;
      if (targetBoard === undefined) {
        let existing: { board?: string } | null = null;
        if (input.externalRef) {
          existing = await store.findSessionByExternalRef(input.externalRef);
        }
        if (!existing && input.id) {
          existing = await store.getSession(input.id);
        }
        if (existing?.board) targetBoard = existing.board;
      }
      const slug = await resolveSlug(targetBoard);
      const session = await store.registerSession(slug, input, {
        type: 'agent',
        harness: input.harness ?? 'mcp',
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
          kind: DiagramKindSchema.optional(),
          content: z.string().min(1).max(MCP_MAX_TEXT_CHARS),
          description: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          jobId: EntityIdSchema.optional().describe('Optional claimed refresh job ID fulfilled by this version'),
          leaseToken: z
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe('Active lease token from job_claim (required when jobId is set)'),
          note: z.string().max(500).optional(),
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
    'media_update',
    {
      title: 'Update Media Artifact (New Immutable Version)',
      description:
        'Create a new immutable version (<id>.v<N>.<ext>) of an existing media artifact (binary replacement, updated doc/html/json content, transcript, or decision links). Pass jobId when fulfilling a refresh job.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          mediaId: EntityIdSchema,
          title: z.string().min(1).max(300).optional(),
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
          jobId: EntityIdSchema.optional().describe('Optional claimed refresh job ID fulfilled by this version'),
          leaseToken: z
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe('Active lease token from job_claim (required when jobId is set)'),
          note: z.string().max(500).optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, mediaId, harness, sessionId, sourceFilePath, ...patch }) => {
      const slug = await resolveSlug(board, sessionId);
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
      const updated = await store.updateMedia(
        slug,
        mediaId,
        {
          ...patch,
          ...(safeSourcePath !== undefined ? { sourceFilePath: safeSourcePath } : {}),
          maxBytes: maxMediaBytes,
        },
        {
          type: 'agent',
          harness: harness ?? 'mcp',
          sessionId: sessionId ?? undefined,
        },
      );
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
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
    'quiz_update',
    {
      title: 'Update Quiz (Preserves Attempts)',
      description:
        'Publish a new version of an existing quiz while preserving all past human quiz attempts. Pass jobId when fulfilling a refresh job.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          quizId: EntityIdSchema,
          title: z.string().min(1).max(300).optional(),
          topic: z.string().max(300).optional(),
          description: z.string().max(MCP_MAX_TEXT_CHARS).optional(),
          questions: z.array(QuizQuestionSchema).min(1).max(100).optional(),
          basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
          jobId: EntityIdSchema.optional().describe('Optional claimed refresh job ID fulfilled by this version'),
          leaseToken: z
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe('Active lease token from job_claim (required when jobId is set)'),
          note: z.string().max(500).optional(),
          sessionId: EntityIdSchema.nullable().optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, quizId, harness, sessionId, ...patch }) => {
      const slug = await resolveSlug(board, sessionId);
      const quiz = await store.updateQuiz(slug, quizId, patch, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId: sessionId ?? undefined,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(quiz, null, 2) }],
      };
    },
  );

  server.registerTool(
    'artifact_confirm',
    {
      title: 'Confirm Stale Artifact Still Accurate (Agent)',
      description:
        'Record an agent confirmation (with required note) that a stale diagram, media artifact, or quiz still holds against the latest superseding decision(s), without rewriting basedOnDecisions. Automatically re-stales on the next supersession.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          artifactType: RefreshJobArtifactTypeSchema,
          artifactId: EntityIdSchema,
          note: z
            .string()
            .trim()
            .min(1)
            .max(1000)
            .describe('Required non-blank rationale explaining why the artifact is still accurate'),
          decisionIds: z.array(EntityIdSchema).max(100).optional(),
          artifactVersion: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Optional displayed artifact version; conflicts if artifact changed'),
          expectedAgainst: z
            .record(EntityIdSchema, EntityIdSchema)
            .optional()
            .describe('Optional map of staleDecisionId -> expected replacement decisionId'),
          harness: z.string().max(100).optional(),
          sessionId: EntityIdSchema.optional(),
        })
        .strict(),
    },
    async ({
      board,
      artifactType,
      artifactId,
      note,
      decisionIds,
      artifactVersion,
      expectedAgainst,
      harness,
      sessionId,
    }) => {
      const slug = await resolveSlug(board, sessionId);
      // D14: MCP-originated confirmations are ALWAYS labeled as agent confirmations, never human.
      const updated = await store.confirmArtifact(
        slug,
        artifactType,
        artifactId,
        { note, decisionIds, artifactVersion, expectedAgainst },
        {
          type: 'agent',
          harness: harness ?? 'mcp',
          sessionId,
          label: harness ?? 'mcp',
        },
      );
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  server.registerTool(
    'job_list',
    {
      title: 'List Refresh Jobs',
      description: 'List queued, claimed, completed, or failed artifact refresh jobs on the board.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema.optional(),
          status: RefreshJobStatusSchema.optional(),
          artifactType: RefreshJobArtifactTypeSchema.optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, status, artifactType }) => {
      const slug = await resolveSlug(board, sessionId);
      const jobs = await store.listJobs(slug, { status, artifactType });
      return {
        content: [{ type: 'text', text: JSON.stringify(redactJobsLeases(jobs), null, 2) }],
      };
    },
  );

  server.registerTool(
    'job_claim',
    {
      title: 'Claim Refresh Job (Atomic Lease)',
      description:
        'Atomically claim a queued (or lease-expired) refresh job and receive a leaseToken valid for 15 minutes (or ttlMs).',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema.optional(),
          jobId: EntityIdSchema.optional(),
          artifactType: RefreshJobArtifactTypeSchema.optional(),
          mediaKind: MediaKindSchema.optional(),
          claimedBy: z.string().min(1).max(200).optional(),
          ttlMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, harness, claimedBy, ...input }) => {
      const slug = await resolveSlug(board, sessionId);
      const claimer = claimedBy ?? (sessionId ? `${harness ?? 'mcp'}:${sessionId}` : harness ?? 'mcp');
      const job = await store.claimJob(
        slug,
        { ...input, claimedBy: claimer },
        {
          type: 'agent',
          harness: harness ?? 'mcp',
          sessionId,
          label: claimer,
        },
      );
      if (job) onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(job, null, 2) }],
      };
    },
  );

  server.registerTool(
    'job_renew',
    {
      title: 'Renew Refresh Job Lease',
      description: 'Extend the lease TTL for a currently claimed refresh job using its leaseToken.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema.optional(),
          jobId: EntityIdSchema,
          leaseToken: z.string().min(1).max(128),
          ttlMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, jobId, leaseToken, ttlMs, harness }) => {
      const slug = await resolveSlug(board, sessionId);
      const job = await store.renewJob(
        slug,
        jobId,
        { leaseToken, ttlMs },
        {
          type: 'agent',
          harness: harness ?? 'mcp',
          sessionId,
        },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(job, null, 2) }],
      };
    },
  );

  server.registerTool(
    'job_release',
    {
      title: 'Release Refresh Job Lease',
      description: 'Return a claimed refresh job back to queued status using its leaseToken.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema.optional(),
          jobId: EntityIdSchema,
          leaseToken: z.string().min(1).max(128),
          reason: z.string().max(1000).optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, jobId, leaseToken, reason, harness }) => {
      const slug = await resolveSlug(board, sessionId);
      const job = await store.releaseJob(
        slug,
        jobId,
        { leaseToken, reason },
        {
          type: 'agent',
          harness: harness ?? 'mcp',
          sessionId,
        },
      );
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(redactJobLease(job), null, 2) }],
      };
    },
  );

  server.registerTool(
    'job_complete',
    {
      title: 'Complete Refresh Job',
      description:
        'Mark a claimed refresh job done (or failed). Marking done strictly requires that the target artifact has a new version (> baseVersion) created by the active claim.',
      inputSchema: z
        .object({
          board: BoardSlugSchema.optional(),
          sessionId: EntityIdSchema.optional(),
          jobId: EntityIdSchema,
          leaseToken: z.string().min(1).max(128),
          status: z.enum(['done', 'failed']).optional(),
          artifactVersion: z.number().int().min(1).optional(),
          summary: z.string().max(2000).optional(),
          error: z.string().max(2000).optional(),
          harness: z.string().max(100).optional(),
        })
        .strict(),
    },
    async ({ board, sessionId, jobId, harness, ...input }) => {
      const slug = await resolveSlug(board, sessionId);
      const job = await store.completeJob(slug, jobId, input, {
        type: 'agent',
        harness: harness ?? 'mcp',
        sessionId,
      });
      onMutate?.(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(redactJobLease(job), null, 2) }],
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
  const server = createContextDeckMcpServer(store, {
    defaultBoard,
    enableResourceSubscriptions: true,
  });
  const transport = new StdioServerTransport();

  // D10 / AC5.8: MCP stdio watches only boards/*/board.yaml (depth 2) and notifies subscribers
  const watcher = attachMcpResourceWatcher(server, store);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdin.removeListener('end', onShutdown);
    process.stdin.removeListener('close', onShutdown);
    process.removeListener('SIGINT', onShutdown);
    process.removeListener('SIGTERM', onShutdown);
    await Promise.allSettled([
      watcher ? watcher.close() : Promise.resolve(),
      server.close(),
    ]);
    process.stdin.pause();
    (process.stdin as { unref?: () => void }).unref?.();
  };
  const onShutdown = () => {
    void shutdown();
  };

  transport.onclose = onShutdown;
  process.stdin.once('end', onShutdown);
  process.stdin.once('close', onShutdown);
  process.once('SIGINT', onShutdown);
  process.once('SIGTERM', onShutdown);

  await server.connect(transport);
}
