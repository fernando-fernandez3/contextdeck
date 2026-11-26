import { z } from 'zod';
import { BOARD_SLUG_REGEX, ENTITY_ID_REGEX } from './ids.js';

export const BoardSlugSchema = z
  .string()
  .regex(BOARD_SLUG_REGEX, 'Board slug must be lowercase alphanumeric, dash, or underscore (max 81 chars)');

export const EntityIdSchema = z
  .string()
  .regex(ENTITY_ID_REGEX, 'Entity ID must be alphanumeric, dash, or underscore (max 81 chars)');

export const IsoDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
    'Timestamp must be a valid ISO-8601 datetime string',
  )
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'Timestamp must be a parseable ISO-8601 datetime string',
  });

export const HttpUrlSchema = z.string().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'URL must be a valid http:// or https:// URL' },
);

export const KnownHarnessSchema = z.enum([
  'cursor',
  'claude-code',
  'codex',
  'grok',
  'windsurf',
  'antigravity',
  'chatgpt',
  'skill',
  'human',
  'custom',
]);

export const LensConfigSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1).max(200),
  kind: z.enum(['catchup', 'brief', 'sessions', 'decisions_canvas', 'tasks', 'media_mastery', 'custom']),
  enabled: z.boolean().default(true),
  icon: z.string().max(80).optional(),
  artifactKinds: z.array(z.string().max(80)).optional(),
});

export type LensConfig = z.infer<typeof LensConfigSchema>;

export const DEFAULT_LENSES: LensConfig[] = [
  { id: 'catchup', title: 'Catch up', kind: 'catchup', enabled: true, icon: 'inbox' },
  { id: 'brief', title: 'Brief', kind: 'brief', enabled: true, icon: 'compass' },
  { id: 'sessions', title: 'Sessions', kind: 'sessions', enabled: true, icon: 'git-branch' },
  { id: 'decisions', title: 'Architecture & Decisions', kind: 'decisions_canvas', enabled: true, icon: 'network' },
  { id: 'tasks', title: 'Tasks', kind: 'tasks', enabled: true, icon: 'kanban' },
  { id: 'media', title: 'Media & Mastery', kind: 'media_mastery', enabled: true, icon: 'play-circle' },
];

export const BoardPathGlobSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (value) => !value.includes('\0') && !value.split(/[\\/]/).includes('..'),
    'Board path glob must not contain NUL bytes or ".." traversal segments',
  );

export const BoardConfigSchema = z.object({
  id: EntityIdSchema,
  slug: BoardSlugSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  revision: z.number().int().min(1).default(1),
  lenses: z.array(LensConfigSchema).default(DEFAULT_LENSES),
  parentBoard: BoardSlugSchema.nullable().optional(),
  paths: z.array(BoardPathGlobSchema).max(100).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export const SessionStatusSchema = z.enum(['active', 'idle', 'paused', 'completed', 'archived']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Git-tracked workspace-scoped session metadata (`<deck>/sessions/<id>.yaml`, D11).
 * Never stores volatile sync state (`syncedRevisions`, `lastActiveAt`, or throttle timestamps).
 */
export const SessionMetadataSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  harness: z.string().min(1).default('custom'),
  externalRef: z.string().optional(),
  board: BoardSlugSchema,
  parentSessionId: EntityIdSchema.nullable().default(null),
  relatedSessionIds: z.array(EntityIdSchema).default([]),
  status: SessionStatusSchema.default('active'),
  summary: z.string().default(''),
  focusFiles: z.array(z.string()).default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

/**
 * Legacy-tolerant session file schema used when reading pre-B2 board-scoped
 * `<deck>/boards/<slug>/sessions/<id>.yaml` files before first-write migration (D11).
 */
export const LegacySessionFileSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  harness: z.string().min(1).default('custom'),
  externalRef: z.string().optional(),
  board: BoardSlugSchema.optional(),
  parentSessionId: EntityIdSchema.nullable().default(null),
  relatedSessionIds: z.array(EntityIdSchema).default([]),
  status: SessionStatusSchema.default('active'),
  summary: z.string().default(''),
  focusFiles: z.array(z.string()).default([]),
  lastSyncedRevision: z.number().int().min(0).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type LegacySessionFile = z.infer<typeof LegacySessionFileSchema>;

/**
 * Gitignored volatile per-session sync cursor (`<deck>/.runtime/cursors/<id>.json`, D11/D12).
 */
export const SessionCursorSchema = z.object({
  sessionId: EntityIdSchema,
  syncedRevisions: z.record(BoardSlugSchema, z.number().int().min(0)).default({}),
  lastActiveAt: IsoDateTimeSchema,
  lastCursorInjectAt: IsoDateTimeSchema.optional(),
});

export type SessionCursor = z.infer<typeof SessionCursorSchema>;

export const SessionSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  harness: z.string().min(1).default('custom'),
  externalRef: z.string().optional(),
  board: BoardSlugSchema.optional(),
  parentSessionId: EntityIdSchema.nullable().default(null),
  relatedSessionIds: z.array(EntityIdSchema).default([]),
  status: SessionStatusSchema.default('active'),
  summary: z.string().default(''),
  focusFiles: z.array(z.string()).default([]),
  lastSyncedRevision: z.number().int().min(0).default(1),
  lastActiveAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type Session = z.infer<typeof SessionSchema>;

export const NonSupersededDecisionStatusSchema = z.enum(['proposed', 'accepted', 'deprecated']);
export type NonSupersededDecisionStatus = z.infer<typeof NonSupersededDecisionStatusSchema>;

export const DecisionStatusSchema = z.enum(['proposed', 'accepted', 'superseded', 'deprecated']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  status: DecisionStatusSchema.default('accepted'),
  statusBeforeSupersede: NonSupersededDecisionStatusSchema.optional(),
  supersedes: EntityIdSchema.nullable().optional(),
  supersededBy: EntityIdSchema.nullable().optional(),
  sessionId: EntityIdSchema.nullable().optional(),
  tags: z.array(z.string()).default([]),
  summary: z.string().default(''),
  rationale: z.string().default(''),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type Decision = z.infer<typeof DecisionSchema>;

export const TaskColumnSchema = z.enum(['backlog', 'in_progress', 'in_review', 'done']);
export type TaskColumn = z.infer<typeof TaskColumnSchema>;

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  column: TaskColumnSchema.default('backlog'),
  priority: TaskPrioritySchema.default('medium'),
  assignee: z.string().default('unassigned'),
  linkedSessionIds: z.array(EntityIdSchema).default([]),
  linkedDecisionIds: z.array(EntityIdSchema).default([]),
  tags: z.array(z.string()).default([]),
  description: z.string().default(''),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type Task = z.infer<typeof TaskSchema>;

export const ActorSchema = z
  .object({
    type: z.enum(['human', 'agent', 'system']).default('agent'),
    harness: z.string().max(100).optional(),
    sessionId: EntityIdSchema.optional(),
    label: z.string().max(120).optional(),
  })
  .strict();

export type Actor = z.infer<typeof ActorSchema>;

export const ArtifactConfirmationSchema = z
  .object({
    againstDecisionId: EntityIdSchema,
    confirmedBy: z.string().min(1).max(120),
    actorType: z.enum(['human', 'agent']),
    confirmedAt: IsoDateTimeSchema,
    note: z.string().max(1000).default(''),
  })
  .strict();

export type ArtifactConfirmation = z.infer<typeof ArtifactConfirmationSchema>;

export const ArtifactVersionEntrySchema = z
  .object({
    version: z.number().int().min(1),
    updatedAt: IsoDateTimeSchema,
    boardRevision: z.number().int().min(1),
    actor: ActorSchema.optional(),
    basedOnDecisions: z.array(EntityIdSchema).default([]),
    filePath: z.string().optional(),
    createdByJob: EntityIdSchema.optional(),
    createdByClaim: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export type ArtifactVersionEntry = z.infer<typeof ArtifactVersionEntrySchema>;

export const DiagramKindSchema = z.enum(['mermaid', 'excalidraw']);
export type DiagramKind = z.infer<typeof DiagramKindSchema>;

export const DiagramSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  kind: DiagramKindSchema,
  content: z.string(),
  description: z.string().default(''),
  basedOnDecisions: z.array(EntityIdSchema).default([]),
  version: z.number().int().min(1).default(1),
  history: z.array(ArtifactVersionEntrySchema).max(10).default([]),
  confirmations: z.record(EntityIdSchema, ArtifactConfirmationSchema).default({}),
  sessionId: EntityIdSchema.nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type Diagram = z.infer<typeof DiagramSchema>;

export const QuizQuestionSchema = z
  .object({
    id: EntityIdSchema,
    prompt: z.string().min(1).max(20 * 1024),
    type: z.enum(['multiple_choice', 'true_false', 'short_answer']).default('multiple_choice'),
    options: z.array(z.string().max(2 * 1024)).max(50).optional(),
    correctIndex: z.number().int().nonnegative().optional(),
    correctAnswer: z.string().max(20 * 1024).optional(),
    explanation: z.string().max(20 * 1024).default(''),
    relatedDecisionIds: z.array(EntityIdSchema).max(100).default([]),
  })
  .strict();

export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const QuizAttemptSchema = z.object({
  id: EntityIdSchema,
  takenAt: IsoDateTimeSchema,
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  percentage: z.number().min(0).max(100),
  confidence: z.number().min(1).max(5).optional(),
  answers: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
});

export type QuizAttempt = z.infer<typeof QuizAttemptSchema>;

export const QuizSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  topic: z.string().default(''),
  description: z.string().default(''),
  questions: z.array(QuizQuestionSchema).min(1),
  attempts: z.array(QuizAttemptSchema).default([]),
  basedOnDecisions: z.array(EntityIdSchema).default([]),
  version: z.number().int().min(1).default(1),
  history: z.array(ArtifactVersionEntrySchema).max(10).default([]),
  confirmations: z.record(EntityIdSchema, ArtifactConfirmationSchema).default({}),
  sessionId: EntityIdSchema.nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type Quiz = z.infer<typeof QuizSchema>;

export const MediaKindSchema = z.enum(['video', 'audio', 'doc', 'link', 'html', 'json', 'custom']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaChapterSchema = z
  .object({
    timeSec: z.number().nonnegative(),
    title: z.string().min(1).max(300),
  })
  .strict();

export const MediaArtifactSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  kind: MediaKindSchema,
  mimeType: z.string().optional(),
  filePath: z.string().optional(),
  externalUrl: HttpUrlSchema.optional(),
  content: z.string().optional(),
  transcript: z.string().optional(),
  chapters: z.array(MediaChapterSchema).default([]),
  durationSec: z.number().nonnegative().optional(),
  tags: z.array(z.string()).default([]),
  basedOnDecisions: z.array(EntityIdSchema).default([]),
  version: z.number().int().min(1).default(1),
  history: z.array(ArtifactVersionEntrySchema).max(10).default([]),
  confirmations: z.record(EntityIdSchema, ArtifactConfirmationSchema).default({}),
  sessionId: EntityIdSchema.nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  customLensId: EntityIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type MediaArtifact = z.infer<typeof MediaArtifactSchema>;

export const RefreshJobArtifactTypeSchema = z.enum(['diagram', 'media', 'quiz']);
export type RefreshJobArtifactType = z.infer<typeof RefreshJobArtifactTypeSchema>;

export const RefreshJobStatusSchema = z.enum(['queued', 'claimed', 'done', 'failed']);
export type RefreshJobStatus = z.infer<typeof RefreshJobStatusSchema>;

export const RefreshJobResultSchema = z
  .object({
    artifactVersion: z.number().int().min(1).optional(),
    summary: z.string().max(2000).optional(),
    error: z.string().max(2000).optional(),
  })
  .strict();

export type RefreshJobResult = z.infer<typeof RefreshJobResultSchema>;

export const RefreshJobSchema = z.object({
  id: EntityIdSchema,
  kind: z.literal('refresh').default('refresh'),
  artifactType: RefreshJobArtifactTypeSchema,
  artifactId: EntityIdSchema,
  artifactTitle: z.string().max(300).default(''),
  mediaKind: MediaKindSchema.optional(),
  diagramKind: DiagramKindSchema.optional(),
  reason: z.string().max(2000).default(''),
  decisionsBefore: z.array(EntityIdSchema).default([]),
  decisionsNow: z.array(EntityIdSchema).default([]),
  baseVersion: z.number().int().min(1).default(1),
  inputFilePath: z.string().optional(),
  inputContentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  status: RefreshJobStatusSchema.default('queued'),
  claimedBy: z.string().max(200).nullable().default(null),
  leaseToken: z.string().max(128).nullable().default(null),
  claimedAt: IsoDateTimeSchema.nullable().default(null),
  leaseExpiresAt: IsoDateTimeSchema.nullable().default(null),
  result: RefreshJobResultSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type RefreshJob = z.infer<typeof RefreshJobSchema>;

export const ReaderBoardCursorSchema = z
  .object({
    lastReviewedRevision: z.number().int().min(0),
    lastReviewedAt: IsoDateTimeSchema,
  })
  .strict();

export type ReaderBoardCursor = z.infer<typeof ReaderBoardCursorSchema>;

export const ReaderCursorFileSchema = z
  .object({
    readerId: EntityIdSchema,
    boards: z.record(BoardSlugSchema, ReaderBoardCursorSchema).default({}),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type ReaderCursorFile = z.infer<typeof ReaderCursorFileSchema>;

export const BoardEventSchema = z.object({
  id: EntityIdSchema,
  revision: z.number().int().min(1),
  timestamp: IsoDateTimeSchema,
  actor: ActorSchema,
  kind: z.string().min(1),
  entityId: z.string().optional(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type BoardEvent = z.infer<typeof BoardEventSchema>;

// ---------------------------------------------------------------------------
// Strict per-operation input schemas (E1 amended, D5, D6)
// Storage-managed fields (filePath, createdAt, updatedAt, id on update,
// boardRevisionAtUpdate, version, supersededBy, attempts) are forbidden.
// ---------------------------------------------------------------------------

export const CreateBoardInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    slug: BoardSlugSchema.optional(),
    description: z.string().max(5000).optional(),
    brief: z.string().max(200 * 1024).optional(),
    lenses: z.array(LensConfigSchema).optional(),
    parentBoard: BoardSlugSchema.nullable().optional(),
    paths: z.array(BoardPathGlobSchema).max(100).optional(),
    setAsDefault: z.boolean().optional(),
  })
  .strict();

export const UpdateBoardInputSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    lenses: z.array(LensConfigSchema).optional(),
    parentBoard: BoardSlugSchema.nullable().optional(),
    paths: z.array(BoardPathGlobSchema).max(100).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpdateBriefInputSchema = z
  .object({
    brief: z.string().max(200 * 1024),
    baseRevision: z.number().int().min(1).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const RegisterSessionInputSchema = z
  .object({
    id: EntityIdSchema.optional(),
    title: z.string().min(1).max(300),
    harness: z.string().min(1).max(100).optional(),
    externalRef: z.string().max(500).optional(),
    parentSessionId: EntityIdSchema.nullable().optional(),
    relatedSessionIds: z.array(EntityIdSchema).max(100).optional(),
    status: SessionStatusSchema.optional(),
    summary: z.string().max(20 * 1024).optional(),
    focusFiles: z.array(z.string().max(500)).max(200).optional(),
    lastSyncedRevision: z.number().int().min(0).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpdateSessionPatchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    harness: z.string().min(1).max(100).optional(),
    externalRef: z.string().max(500).optional(),
    board: BoardSlugSchema.optional(),
    parentSessionId: EntityIdSchema.nullable().optional(),
    relatedSessionIds: z.array(EntityIdSchema).max(100).optional(),
    status: SessionStatusSchema.optional(),
    summary: z.string().max(20 * 1024).optional(),
    focusFiles: z.array(z.string().max(500)).max(200).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const SyncSessionInputSchema = z
  .object({
    ackRevision: z.number().int().min(0).optional(),
  })
  .strict();

export const RecordDecisionInputSchema = z
  .object({
    id: EntityIdSchema.optional(),
    title: z.string().min(1).max(300),
    status: DecisionStatusSchema.optional(),
    supersedes: EntityIdSchema.nullable().optional(),
    sessionId: EntityIdSchema.nullable().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    summary: z.string().max(20 * 1024).optional(),
    rationale: z.string().max(50 * 1024).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpdateDecisionPatchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    status: DecisionStatusSchema.optional(),
    summary: z.string().max(20 * 1024).optional(),
    rationale: z.string().max(50 * 1024).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    supersedes: EntityIdSchema.nullable().optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpsertTaskInputSchema = z
  .object({
    id: EntityIdSchema.optional(),
    title: z.string().min(1).max(300),
    column: TaskColumnSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assignee: z.string().max(120).optional(),
    linkedSessionIds: z.array(EntityIdSchema).max(100).optional(),
    linkedDecisionIds: z.array(EntityIdSchema).max(100).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    description: z.string().max(50 * 1024).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const PatchTaskInputSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    column: TaskColumnSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assignee: z.string().max(120).optional(),
    linkedSessionIds: z.array(EntityIdSchema).max(100).optional(),
    linkedDecisionIds: z.array(EntityIdSchema).max(100).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    description: z.string().max(50 * 1024).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpsertDiagramInputSchema = z
  .object({
    id: EntityIdSchema.optional(),
    title: z.string().min(1).max(300),
    kind: DiagramKindSchema.optional(),
    content: z.string().max(512 * 1024),
    description: z.string().max(20 * 1024).optional(),
    basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
    sessionId: EntityIdSchema.nullable().optional(),
    jobId: EntityIdSchema.optional(),
    leaseToken: z.string().min(1).max(128).optional(),
    note: z.string().max(500).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const RestUpdateDiagramInputSchema = UpsertDiagramInputSchema.omit({ id: true }).strict();

export const RestAddMediaInputSchema = z
  .object({
    id: EntityIdSchema.optional(),
    title: z.string().min(1).max(300),
    kind: MediaKindSchema,
    mimeType: z.string().max(120).optional(),
    externalUrl: HttpUrlSchema.optional(),
    content: z.string().max(512 * 1024).optional(),
    transcript: z.string().max(200 * 1024).optional(),
    chapters: z.array(MediaChapterSchema).max(200).optional(),
    durationSec: z.number().nonnegative().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
    sessionId: EntityIdSchema.nullable().optional(),
    customLensId: EntityIdSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpdateMediaPatchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    content: z.string().max(512 * 1024).optional(),
    transcript: z.string().max(200 * 1024).optional(),
    chapters: z.array(MediaChapterSchema).max(200).optional(),
    durationSec: z.number().nonnegative().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
    externalUrl: HttpUrlSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    jobId: EntityIdSchema.optional(),
    leaseToken: z.string().min(1).max(128).optional(),
    note: z.string().max(500).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const CreateQuizInputSchema = z
  .object({
    id: EntityIdSchema.optional(),
    title: z.string().min(1).max(300),
    topic: z.string().max(300).optional(),
    description: z.string().max(20 * 1024).optional(),
    questions: z.array(QuizQuestionSchema).min(1).max(100),
    basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
    sessionId: EntityIdSchema.nullable().optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const UpdateQuizPatchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    topic: z.string().max(300).optional(),
    description: z.string().max(20 * 1024).optional(),
    questions: z.array(QuizQuestionSchema).min(1).max(100).optional(),
    basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
    jobId: EntityIdSchema.optional(),
    leaseToken: z.string().min(1).max(128).optional(),
    note: z.string().max(500).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const SubmitQuizAttemptInputSchema = z
  .object({
    answers: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    confidence: z.number().min(1).max(5).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const ConfirmArtifactInputSchema = z
  .object({
    note: z.string().max(1000).optional(),
    decisionIds: z.array(EntityIdSchema).max(100).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const CreateRefreshJobInputSchema = z
  .object({
    artifactType: RefreshJobArtifactTypeSchema,
    artifactId: EntityIdSchema,
    reason: z.string().max(2000).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const ClaimJobInputSchema = z
  .object({
    jobId: EntityIdSchema.optional(),
    artifactType: RefreshJobArtifactTypeSchema.optional(),
    mediaKind: MediaKindSchema.optional(),
    claimedBy: z.string().min(1).max(200),
    ttlMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const RenewJobInputSchema = z
  .object({
    leaseToken: z.string().min(1).max(128),
    ttlMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const ReleaseJobInputSchema = z
  .object({
    leaseToken: z.string().min(1).max(128),
    reason: z.string().max(1000).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const CompleteJobInputSchema = z
  .object({
    leaseToken: z.string().min(1).max(128),
    status: z.enum(['done', 'failed']).optional(),
    artifactVersion: z.number().int().min(1).optional(),
    summary: z.string().max(2000).optional(),
    error: z.string().max(2000).optional(),
    actor: ActorSchema.optional(),
  })
  .strict();

export const AckReaderCursorInputSchema = z
  .object({
    revision: z.number().int().min(0),
    readerId: EntityIdSchema.optional(),
  })
  .strict();

export interface StaleArtifactNotice {
  artifactType: 'diagram' | 'media' | 'quiz' | 'task';
  artifactId: string;
  title: string;
  staleDecisionIds: string[];
  reasons: string[];
}

export interface DriftDigestEntry {
  key: string;
  revision: number;
  kind: string;
  entityId?: string;
  summary: string;
  actorLabel: string;
  timestamp: string;
}

export interface DriftedSessionNotice {
  sessionId: string;
  title: string;
  harness: string;
  lastSyncedRevision: number;
  currentRevision: number;
  behindBy: number;
  digest: DriftDigestEntry[];
  digestText: string;
  truncatedCount: number;
}

export interface DriftReport {
  currentRevision: number;
  staleArtifacts: StaleArtifactNotice[];
  driftedSessions: DriftedSessionNotice[];
  /**
   * False when per-session drift was intentionally skipped (e.g. lightweight hook startup snapshots).
   * Formatters must not claim sessions are "synced" when this is false.
   */
  sessionDriftComputed?: boolean;
  /**
   * ISO timestamp at which drift eligibility (e.g. 7-day inactivity cutoff) was evaluated.
   */
  evaluatedAt?: string;
}

export interface CatchUpDecisionChange {
  decisionId: string;
  title: string;
  status: DecisionStatus;
  summary: string;
  rationaleLine: string;
  previousDecisionId?: string;
  previousTitle?: string;
  revision: number;
  timestamp: string;
}

export interface CatchUpStaleArtifact {
  artifactType: RefreshJobArtifactType;
  artifactId: string;
  title: string;
  staleDecisionIds: string[];
  reasons: string[];
  activeJob: {
    id: string;
    status: RefreshJobStatus;
    claimedBy: string | null;
  } | null;
}

export interface CatchUpTaskMove {
  taskId: string;
  title: string;
  fromColumn: TaskColumn | null;
  toColumn: TaskColumn;
  revision: number;
}

export interface CatchUpNewSession {
  sessionId: string;
  title: string;
  harness: string;
  createdAt: string;
}

export interface CatchUpReport {
  fromRevision: number;
  toRevision: number;
  lastReviewedAt: string | null;
  unseenCount: number;
  hasUnseen: boolean;
  decisionsChanged: CatchUpDecisionChange[];
  staleArtifacts: CatchUpStaleArtifact[];
  tasksMoved: CatchUpTaskMove[];
  newSessions: CatchUpNewSession[];
}

export interface BoardSnapshot {
  config: BoardConfig;
  brief: string;
  sessions: Session[];
  decisions: Decision[];
  tasks: Task[];
  diagrams: Diagram[];
  media: MediaArtifact[];
  quizzes: Quiz[];
  jobs: RefreshJob[];
  events: BoardEvent[];
  drift: DriftReport;
}

export const ContextUpdatePayloadSchema = z
  .object({
    baseRevision: z.number().int().min(1).optional(),
    sessionId: EntityIdSchema.optional(),
    sessionTitle: z.string().min(1).max(300).optional(),
    harness: z.string().min(1).max(100).optional(),
    sessionSummary: z.string().max(20 * 1024).optional(),
    brief: z.string().max(200 * 1024).optional(),
    decisions: z
      .array(
        z
          .object({
            title: z.string().min(1).max(300),
            summary: z.string().max(20 * 1024).default(''),
            rationale: z.string().max(50 * 1024).default(''),
            status: DecisionStatusSchema.optional(),
            supersedes: EntityIdSchema.nullable().optional(),
            tags: z.array(z.string().max(100)).optional(),
          })
          .strict(),
      )
      .optional(),
    tasks: z
      .array(
        z
          .object({
            id: EntityIdSchema.optional(),
            title: z.string().min(1).max(300),
            column: TaskColumnSchema.optional(),
            priority: TaskPrioritySchema.optional(),
            assignee: z.string().max(120).optional(),
            description: z.string().max(50 * 1024).optional(),
            linkedDecisionIds: z.array(EntityIdSchema).optional(),
            tags: z.array(z.string().max(100)).optional(),
          })
          .strict(),
      )
      .optional(),
    diagrams: z
      .array(
        z
          .object({
            id: EntityIdSchema.optional(),
            title: z.string().min(1).max(300),
            kind: DiagramKindSchema.default('mermaid'),
            content: z.string().min(1).max(512 * 1024),
            description: z.string().max(20 * 1024).optional(),
            basedOnDecisions: z.array(EntityIdSchema).optional(),
          })
          .strict(),
      )
      .optional(),
    quizzes: z
      .array(
        z
          .object({
            title: z.string().min(1).max(300),
            topic: z.string().max(300).optional(),
            description: z.string().max(20 * 1024).optional(),
            questions: z.array(QuizQuestionSchema).min(1),
            basedOnDecisions: z.array(EntityIdSchema).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.brief !== undefined && data.baseRevision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseRevision'],
        message: 'baseRevision is required when payload includes "brief"',
      });
    }
  });

export type ContextUpdatePayload = z.infer<typeof ContextUpdatePayloadSchema>;
