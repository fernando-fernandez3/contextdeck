import type {
  BoardConfig,
  BoardSnapshot,
  Decision,
  Diagram,
  MediaArtifact,
  MediaKind,
  Quiz,
  QuizAttempt,
  Session,
  Task,
} from './types';

export class AuthExpiredError extends Error {
  public readonly status = 401;

  constructor(message = 'Session expired. Run `cdeck open` to obtain a fresh launch URL.') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly data?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// Keep CSRF token strictly in memory (never localStorage — AC8.4)
let csrfToken: string | null = null;
let authExpiredListener: (() => void) | null = null;

export function setAuthExpiredHandler(handler: (() => void) | null): void {
  authExpiredListener = handler;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function fetchSessionCsrf(): Promise<string> {
  const res = await fetch('/api/session', {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    csrfToken = null;
    authExpiredListener?.();
    throw new AuthExpiredError();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      String(body.error || `Session check failed (${res.status})`),
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
      body,
    );
  }
  const data = (await res.json()) as { authenticated: boolean; csrfToken: string };
  csrfToken = data.csrfToken;
  return data.csrfToken;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? {});

  if (MUTATING_METHODS.has(method)) {
    const token = csrfToken ?? (await fetchSessionCsrf());
    headers.set('X-CSRF-Token', token);
  }

  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers,
  });

  if (res.status === 401) {
    csrfToken = null;
    authExpiredListener?.();
    throw new AuthExpiredError();
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      String(body.error || `Request failed (${res.status})`),
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
      body,
    );
  }
  return res.json() as Promise<T>;
}

export const api = {
  initSession: fetchSessionCsrf,

  listBoards: () => req<{ defaultBoard: string | null; boards: BoardConfig[] }>('/api/boards'),

  createBoard: (input: {
    title: string;
    slug?: string;
    description?: string;
    parentBoard?: string | null;
    paths?: string[];
  }) =>
    req<BoardConfig>('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  seedDemo: () =>
    req<BoardSnapshot>('/api/boards/demo', {
      method: 'POST',
    }),

  getBoard: (slug: string) => req<BoardSnapshot>(`/api/boards/${encodeURIComponent(slug)}`),

  getContextPack: (slug: string, includeProtocol = true) =>
    req<{ slug: string; revision: number; markdown: string }>(
      `/api/boards/${encodeURIComponent(slug)}/context-pack?protocol=${includeProtocol}`,
    ),

  applyContextUpdate: (slug: string, raw: string) =>
    req<{ appliedCount: number; sessionId?: string; snapshot: BoardSnapshot }>(
      `/api/boards/${encodeURIComponent(slug)}/apply-update`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      },
    ),

  updateBrief: (slug: string, brief: string, baseRevision?: number) =>
    req<{ revision: number; brief: string }>(`/api/boards/${encodeURIComponent(slug)}/brief`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brief,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
      }),
    }),

  registerSession: (slug: string, input: Partial<Session> & { title: string }) =>
    req<Session>(`/api/boards/${encodeURIComponent(slug)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateSession: (slug: string, id: string, patch: Partial<Session>) =>
    req<Session>(`/api/boards/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  syncSession: (slug: string, id: string, ackRevision?: number) =>
    req<{ session: Session; currentRevision: number }>(
      `/api/boards/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}/sync`,
      {
        method: 'POST',
        ...(ackRevision !== undefined
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ackRevision }),
            }
          : {}),
      },
    ),

  deleteSession: (slug: string, id: string) =>
    req<{ deleted: boolean }>(
      `/api/boards/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  recordDecision: (slug: string, input: Partial<Decision> & { title: string }) =>
    req<Decision>(`/api/boards/${encodeURIComponent(slug)}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateDecision: (slug: string, id: string, patch: Partial<Decision>) =>
    req<Decision>(`/api/boards/${encodeURIComponent(slug)}/decisions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  createTask: (slug: string, input: Partial<Task> & { title: string }) =>
    req<Task>(`/api/boards/${encodeURIComponent(slug)}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateTask: (slug: string, id: string, patch: Partial<Task>) =>
    req<Task>(`/api/boards/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteTask: (slug: string, id: string) =>
    req<{ deleted: boolean }>(
      `/api/boards/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  upsertDiagram: (slug: string, input: Partial<Diagram> & { title: string; content: string }) => {
    const { id, ...rest } = input;
    return req<Diagram>(
      id
        ? `/api/boards/${encodeURIComponent(slug)}/diagrams/${encodeURIComponent(id)}`
        : `/api/boards/${encodeURIComponent(slug)}/diagrams`,
      {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? rest : input),
      },
    );
  },

  deleteDiagram: (slug: string, id: string) =>
    req<{ deleted: boolean }>(
      `/api/boards/${encodeURIComponent(slug)}/diagrams/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  addMediaJson: (slug: string, input: Partial<MediaArtifact> & { title: string; kind: MediaKind }) =>
    req<MediaArtifact>(`/api/boards/${encodeURIComponent(slug)}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  uploadMediaFile: (slug: string, formData: FormData) =>
    req<MediaArtifact>(`/api/boards/${encodeURIComponent(slug)}/media`, {
      method: 'POST',
      body: formData,
    }),

  deleteMedia: (slug: string, id: string) =>
    req<{ deleted: boolean }>(
      `/api/boards/${encodeURIComponent(slug)}/media/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  createQuiz: (slug: string, input: Partial<Quiz> & { title: string; questions: Quiz['questions'] }) =>
    req<Quiz>(`/api/boards/${encodeURIComponent(slug)}/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  submitQuizAttempt: (
    slug: string,
    quizId: string,
    answers: Record<string, number | string | boolean>,
    confidence?: number,
  ) =>
    req<{ quiz: Quiz; attempt: QuizAttempt }>(
      `/api/boards/${encodeURIComponent(slug)}/quizzes/${encodeURIComponent(quizId)}/attempts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, confidence }),
      },
    ),

  refreshArtifact: (
    slug: string,
    type: 'diagram' | 'media' | 'quiz' | 'task',
    id: string,
  ) =>
    req<{ refreshed: boolean }>(
      `/api/boards/${encodeURIComponent(slug)}/artifacts/${type}/${encodeURIComponent(id)}/refresh`,
      { method: 'POST' },
    ),
};
