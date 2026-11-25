export interface LensConfig {
  id: string;
  title: string;
  kind: 'brief' | 'sessions' | 'decisions_canvas' | 'tasks' | 'media_mastery' | 'custom';
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
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Session {
  id: string;
  title: string;
  harness: string;
  externalRef?: string;
  parentSessionId: string | null;
  relatedSessionIds: string[];
  status: SessionStatus;
  summary: string;
  focusFiles: string[];
  lastSyncedRevision: number;
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

export interface Diagram {
  id: string;
  title: string;
  kind: 'mermaid' | 'excalidraw';
  content: string;
  description: string;
  basedOnDecisions: string[];
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
  sessionId?: string | null;
  boardRevisionAtUpdate: number;
  customLensId?: string;
  metadata: Record<string, unknown>;
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
  drift: {
    currentRevision: number;
    staleArtifacts: StaleArtifactNotice[];
    driftedSessions: DriftedSessionNotice[];
  };
}
