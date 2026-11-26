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
  kind: z.enum(['brief', 'sessions', 'decisions_canvas', 'tasks', 'media_mastery', 'custom']),
  enabled: z.boolean().default(true),
  icon: z.string().max(80).optional(),
  artifactKinds: z.array(z.string().max(80)).optional(),
});

export type LensConfig = z.infer<typeof LensConfigSchema>;

export const DEFAULT_LENSES: LensConfig[] = [
  { id: 'brief', title: 'Brief', kind: 'brief', enabled: true, icon: 'compass' },
  { id: 'sessions', title: 'Sessions', kind: 'sessions', enabled: true, icon: 'git-branch' },
  { id: 'decisions', title: 'Architecture & Decisions', kind: 'decisions_canvas', enabled: true, icon: 'network' },
  { id: 'tasks', title: 'Tasks', kind: 'tasks', enabled: true, icon: 'kanban' },
  { id: 'media', title: 'Media & Mastery', kind: 'media_mastery', enabled: true, icon: 'play-circle' },
];

export const BoardConfigSchema = z.object({
  id: EntityIdSchema,
  slug: BoardSlugSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  revision: z.number().int().min(1).default(1),
  lenses: z.array(LensConfigSchema).default(DEFAULT_LENSES),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export const SessionStatusSchema = z.enum(['active', 'idle', 'paused', 'completed', 'archived']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  harness: z.string().min(1).default('custom'),
  externalRef: z.string().optional(),
  parentSessionId: EntityIdSchema.nullable().default(null),
  relatedSessionIds: z.array(EntityIdSchema).default([]),
  status: SessionStatusSchema.default('active'),
  summary: z.string().default(''),
  focusFiles: z.array(z.string()).default([]),
  lastSyncedRevision: z.number().int().min(0).default(1),
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

export const DiagramKindSchema = z.enum(['mermaid', 'excalidraw']);
export type DiagramKind = z.infer<typeof DiagramKindSchema>;

export const DiagramSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1),
  kind: DiagramKindSchema,
  content: z.string(),
  description: z.string().default(''),
  basedOnDecisions: z.array(EntityIdSchema).default([]),
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
  sessionId: EntityIdSchema.nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  customLensId: EntityIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type MediaArtifact = z.infer<typeof MediaArtifactSchema>;

export const ActorSchema = z
  .object({
    type: z.enum(['human', 'agent', 'system']).default('agent'),
    harness: z.string().max(100).optional(),
    sessionId: EntityIdSchema.optional(),
    label: z.string().max(120).optional(),
  })
  .strict();

export type Actor = z.infer<typeof ActorSchema>;

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
    setAsDefault: z.boolean().optional(),
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
    tags: z.array(z.string().max(100)).max(50).optional(),
    basedOnDecisions: z.array(EntityIdSchema).max(100).optional(),
    externalUrl: HttpUrlSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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

export const SubmitQuizAttemptInputSchema = z
  .object({
    answers: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    confidence: z.number().min(1).max(5).optional(),
    actor: ActorSchema.optional(),
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
