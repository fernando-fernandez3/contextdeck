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

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listBoards: () => req<{ defaultBoard: string; boards: BoardConfig[] }>('/api/boards'),

  createBoard: (input: { title: string; slug?: string; description?: string }) =>
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

  updateBrief: (slug: string, brief: string) =>
    req<{ revision: number; brief: string }>(`/api/boards/${encodeURIComponent(slug)}/brief`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief }),
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

  syncSession: (slug: string, id: string) =>
    req<{ session: Session; currentRevision: number }>(
      `/api/boards/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}/sync`,
      { method: 'POST' },
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

  upsertDiagram: (slug: string, input: Partial<Diagram> & { title: string; content: string }) =>
    req<Diagram>(
      input.id
        ? `/api/boards/${encodeURIComponent(slug)}/diagrams/${encodeURIComponent(input.id)}`
        : `/api/boards/${encodeURIComponent(slug)}/diagrams`,
      {
        method: input.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

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
