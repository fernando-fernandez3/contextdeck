import { z } from 'zod';

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
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['brief', 'sessions', 'decisions_canvas', 'tasks', 'media_mastery', 'custom']),
  enabled: z.boolean().default(true),
  icon: z.string().optional(),
  artifactKinds: z.array(z.string()).optional(),
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
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  revision: z.number().int().min(1).default(1),
  lenses: z.array(LensConfigSchema).default(DEFAULT_LENSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export const SessionStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  harness: z.string().min(1).default('custom'),
  externalRef: z.string().optional(),
  parentSessionId: z.string().nullable().default(null),
  relatedSessionIds: z.array(z.string()).default([]),
  status: SessionStatusSchema.default('active'),
  summary: z.string().default(''),
  focusFiles: z.array(z.string()).default([]),
  lastSyncedRevision: z.number().int().min(0).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Session = z.infer<typeof SessionSchema>;

export const DecisionStatusSchema = z.enum(['proposed', 'accepted', 'superseded', 'deprecated']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: DecisionStatusSchema.default('accepted'),
  supersedes: z.string().nullable().optional(),
  supersededBy: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  summary: z.string().default(''),
  rationale: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const TaskColumnSchema = z.enum(['backlog', 'in_progress', 'in_review', 'done']);
export type TaskColumn = z.infer<typeof TaskColumnSchema>;

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  column: TaskColumnSchema.default('backlog'),
  priority: TaskPrioritySchema.default('medium'),
  assignee: z.string().default('unassigned'),
  linkedSessionIds: z.array(z.string()).default([]),
  linkedDecisionIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  description: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Task = z.infer<typeof TaskSchema>;

export const DiagramKindSchema = z.enum(['mermaid', 'excalidraw']);
export type DiagramKind = z.infer<typeof DiagramKindSchema>;

export const DiagramSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: DiagramKindSchema,
  content: z.string(),
  description: z.string().default(''),
  basedOnDecisions: z.array(z.string()).default([]),
  sessionId: z.string().nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Diagram = z.infer<typeof DiagramSchema>;

export const QuizQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  type: z.enum(['multiple_choice', 'true_false', 'short_answer']).default('multiple_choice'),
  options: z.array(z.string()).optional(),
  correctIndex: z.number().int().nonnegative().optional(),
  correctAnswer: z.string().optional(),
  explanation: z.string().default(''),
  relatedDecisionIds: z.array(z.string()).default([]),
});

export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const QuizAttemptSchema = z.object({
  id: z.string().min(1),
  takenAt: z.string(),
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  percentage: z.number().min(0).max(100),
  confidence: z.number().min(1).max(5).optional(),
  answers: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
});

export type QuizAttempt = z.infer<typeof QuizAttemptSchema>;

export const QuizSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  topic: z.string().default(''),
  description: z.string().default(''),
  questions: z.array(QuizQuestionSchema).min(1),
  attempts: z.array(QuizAttemptSchema).default([]),
  basedOnDecisions: z.array(z.string()).default([]),
  sessionId: z.string().nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Quiz = z.infer<typeof QuizSchema>;

export const MediaKindSchema = z.enum(['video', 'audio', 'doc', 'link', 'html', 'json', 'custom']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaChapterSchema = z.object({
  timeSec: z.number().nonnegative(),
  title: z.string().min(1),
});

export const MediaArtifactSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: MediaKindSchema,
  mimeType: z.string().optional(),
  filePath: z.string().optional(),
  externalUrl: z.string().optional(),
  content: z.string().optional(),
  transcript: z.string().optional(),
  chapters: z.array(MediaChapterSchema).default([]),
  durationSec: z.number().nonnegative().optional(),
  tags: z.array(z.string()).default([]),
  basedOnDecisions: z.array(z.string()).default([]),
  sessionId: z.string().nullable().optional(),
  boardRevisionAtUpdate: z.number().int().min(1).default(1),
  customLensId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MediaArtifact = z.infer<typeof MediaArtifactSchema>;

export const ActorSchema = z.object({
  type: z.enum(['human', 'agent', 'system']).default('agent'),
  harness: z.string().optional(),
  sessionId: z.string().optional(),
  label: z.string().optional(),
});

export type Actor = z.infer<typeof ActorSchema>;

export const BoardEventSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(1),
  timestamp: z.string(),
  actor: ActorSchema,
  kind: z.string().min(1),
  entityId: z.string().optional(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type BoardEvent = z.infer<typeof BoardEventSchema>;

export interface StaleArtifactNotice {
  artifactType: 'diagram' | 'media' | 'quiz' | 'task';
  artifactId: string;
  title: string;
  staleDecisionIds: string[];
  reasons: string[];
}

export interface DriftedSessionNotice {
  sessionId: string;
  title: string;
  harness: string;
  lastSyncedRevision: number;
  currentRevision: number;
  behindBy: number;
  missedEvents: BoardEvent[];
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

export const ContextUpdatePayloadSchema = z.object({
  sessionId: z.string().optional(),
  sessionTitle: z.string().optional(),
  harness: z.string().optional(),
  sessionSummary: z.string().optional(),
  brief: z.string().optional(),
  decisions: z
    .array(
      z.object({
        title: z.string().min(1),
        summary: z.string().default(''),
        rationale: z.string().default(''),
        status: DecisionStatusSchema.optional(),
        supersedes: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        column: TaskColumnSchema.optional(),
        priority: TaskPrioritySchema.optional(),
        assignee: z.string().optional(),
        description: z.string().optional(),
        linkedDecisionIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  diagrams: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        kind: DiagramKindSchema.default('mermaid'),
        content: z.string().min(1),
        description: z.string().optional(),
        basedOnDecisions: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  quizzes: z
    .array(
      z.object({
        title: z.string().min(1),
        topic: z.string().optional(),
        description: z.string().optional(),
        questions: z.array(QuizQuestionSchema).min(1),
        basedOnDecisions: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export type ContextUpdatePayload = z.infer<typeof ContextUpdatePayloadSchema>;
