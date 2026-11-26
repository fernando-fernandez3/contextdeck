export interface LensConfig {
  id: string;
  title: string;
  kind: 'catchup' | 'brief' | 'sessions' | 'decisions_canvas' | 'tasks' | 'media_mastery' | 'custom';
  enabled: boolean;
  icon?: string;
  artifactKinds?: string[];
}

export interface BoardConfig {
  id: string;
  slug: string;
  title: string;
  description: string;
  revision: number;
  lenses: LensConfig[];
  parentBoard?: string | null;
  paths?: string[];
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = 'active' | 'idle' | 'paused' | 'completed' | 'archived';

export interface Session {
  id: string;
  title: string;
  harness: string;
  externalRef?: string;
  board?: string;
  parentSessionId: string | null;
  relatedSessionIds: string[];
  status: SessionStatus;
  summary: string;
  focusFiles: string[];
  lastSyncedRevision: number;
  lastActiveAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';

export interface Decision {
  id: string;
  title: string;
  status: DecisionStatus;
  supersedes?: string | null;
  supersededBy?: string | null;
  sessionId?: string | null;
  tags: string[];
  summary: string;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskColumn = 'backlog' | 'in_progress' | 'in_review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  column: TaskColumn;
  priority: TaskPriority;
  assignee: string;
  linkedSessionIds: string[];
  linkedDecisionIds: string[];
  tags: string[];
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactConfirmation {
  againstDecisionId: string;
  confirmedBy: string;
  actorType: 'human' | 'agent';
  confirmedAt: string;
  note: string;
}

export interface ArtifactVersionEntry {
  version: number;
  updatedAt: string;
  boardRevision: number;
  basedOnDecisions: string[];
  filePath?: string;
  createdByJob?: string;
  createdByClaim?: string;
  note?: string;
}

export interface Diagram {
  id: string;
  title: string;
  kind: 'mermaid' | 'excalidraw';
  content: string;
  description: string;
  basedOnDecisions: string[];
  version?: number;
  history?: ArtifactVersionEntry[];
  confirmations?: Record<string, ArtifactConfirmation>;
  sessionId?: string | null;
  boardRevisionAtUpdate: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  type: 'multiple_choice' | 'true_false' | 'short_answer';
  options?: string[];
  correctIndex?: number;
  correctAnswer?: string;
  explanation: string;
  relatedDecisionIds: string[];
}

export interface QuizAttempt {
  id: string;
  takenAt: string;
  score: number;
  total: number;
  percentage: number;
  confidence?: number;
  answers: Record<string, number | string | boolean>;
}

export interface Quiz {
  id: string;
  title: string;
  topic: string;
  description: string;
  questions: QuizQuestion[];
  attempts: QuizAttempt[];
  basedOnDecisions: string[];
  version?: number;
  history?: ArtifactVersionEntry[];
  confirmations?: Record<string, ArtifactConfirmation>;
  sessionId?: string | null;
  boardRevisionAtUpdate: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaChapter {
  timeSec: number;
  title: string;
}

export type MediaKind = 'video' | 'audio' | 'doc' | 'link' | 'html' | 'json' | 'custom';

export interface MediaArtifact {
  id: string;
  title: string;
  kind: MediaKind;
  mimeType?: string;
  filePath?: string;
  externalUrl?: string;
  content?: string;
  transcript?: string;
  chapters: MediaChapter[];
  durationSec?: number;
  tags: string[];
  basedOnDecisions: string[];
  version?: number;
  history?: ArtifactVersionEntry[];
  confirmations?: Record<string, ArtifactConfirmation>;
  sessionId?: string | null;
  boardRevisionAtUpdate: number;
  customLensId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type RefreshJobArtifactType = 'diagram' | 'media' | 'quiz';
export type RefreshJobStatus = 'queued' | 'claimed' | 'done' | 'failed';

export interface RefreshJob {
  id: string;
  kind: 'refresh';
  artifactType: RefreshJobArtifactType;
  artifactId: string;
  artifactTitle: string;
  mediaKind?: MediaKind;
  diagramKind?: 'mermaid' | 'excalidraw';
  reason: string;
  decisionsBefore: string[];
  decisionsNow: string[];
  baseVersion: number;
  inputFilePath?: string;
  status: RefreshJobStatus;
  claimedBy: string | null;
  leaseToken?: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  result: {
    artifactVersion?: number;
    summary?: string;
    error?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardEvent {
  id: string;
  revision: number;
  timestamp: string;
  actor: {
    type: 'human' | 'agent' | 'system';
    harness?: string;
    sessionId?: string;
    label?: string;
  };
  kind: string;
  entityId?: string;
  summary: string;
}

export interface StaleArtifactNotice {
  artifactType: 'diagram' | 'media' | 'quiz' | 'task';
  artifactId: string;
  title: string;
  staleDecisionIds: string[];
  reasons: string[];
  artifactVersion?: number;
  expectedAgainst?: Record<string, string>;
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
  artifactVersion: number;
  staleDecisionIds: string[];
  expectedAgainst: Record<string, string>;
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

export interface CatchUpOtherChange {
  kind: string;
  title: string;
  actor: string;
  at: string;
}

export interface CatchUpReport {
  fromRevision: number;
  toRevision: number;
  lastReviewedAt: string | null;
  evaluatedAt: string;
  unseenCount: number;
  hasUnseen: boolean;
  decisionsChanged: CatchUpDecisionChange[];
  staleArtifacts: CatchUpStaleArtifact[];
  tasksMoved: CatchUpTaskMove[];
  newSessions: CatchUpNewSession[];
  otherChanges: CatchUpOtherChange[];
  otherChangesTruncated: number;
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
  jobs?: RefreshJob[];
  events: BoardEvent[];
  drift: {
    currentRevision: number;
    staleArtifacts: StaleArtifactNotice[];
    driftedSessions: DriftedSessionNotice[];
  };
}
