import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import yaml from 'js-yaml';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  BoardConfigSchema,
  BoardEventSchema,
  DEFAULT_LENSES,
  DecisionSchema,
  DiagramSchema,
  MediaArtifactSchema,
  QuizAttemptSchema,
  QuizSchema,
  SessionSchema,
  TaskSchema,
  type Actor,
  type BoardConfig,
  type BoardEvent,
  type BoardSnapshot,
  type ContextUpdatePayload,
  type Decision,
  type DecisionStatus,
  type Diagram,
  type DiagramKind,
  type LensConfig,
  type MediaArtifact,
  type MediaKind,
  type Quiz,
  type QuizAttempt,
  type QuizQuestion,
  type Session,
  type SessionStatus,
  type Task,
  type TaskColumn,
  type TaskPriority,
} from './schemas.js';
import { nextSequentialId, nowIso, shortId, slugify } from './ids.js';
import { parseFrontmatter, stringifyFrontmatter } from './markdown.js';
import { computeDriftReport } from './drift.js';

export const CONTEXTDECK_DIR_NAME = '.contextdeck';

interface WorkspaceMeta {
  defaultBoard: string;
  updatedAt: string;
}

const DEFAULT_ACTOR: Actor = { type: 'human', label: 'user' };

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readYamlFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return (yaml.load(raw) ?? null) as T | null;
  } catch {
    return null;
  }
}

async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  const serialized = yaml.dump(data, { lineWidth: 100, noRefs: true, sortKeys: false });
  await fs.writeFile(filePath, serialized, 'utf8');
}

async function listFiles(dirPath: string, suffix?: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (!suffix || e.name.endsWith(suffix)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export class ContextDeckStore {
  public readonly rootDir: string;
  public readonly deckDir: string;
  public readonly boardsDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.deckDir = path.join(this.rootDir, CONTEXTDECK_DIR_NAME);
    this.boardsDir = path.join(this.deckDir, 'boards');
  }

  public isInitialized(): boolean {
    return existsSync(this.boardsDir);
  }

  public boardPath(slug: string): string {
    const safeSlug = slugify(slug);
    return path.join(this.boardsDir, safeSlug);
  }

  private async ensureBoardDirs(slug: string): Promise<string> {
    const dir = this.boardPath(slug);
    await Promise.all([
      ensureDir(dir),
      ensureDir(path.join(dir, 'sessions')),
      ensureDir(path.join(dir, 'decisions')),
      ensureDir(path.join(dir, 'tasks')),
      ensureDir(path.join(dir, 'diagrams')),
      ensureDir(path.join(dir, 'media')),
      ensureDir(path.join(dir, 'quizzes')),
    ]);
    return dir;
  }

  private workspaceMetaPath(): string {
    return path.join(this.deckDir, 'workspace.yaml');
  }

  public async getDefaultBoardSlug(): Promise<string> {
    const meta = await readYamlFile<WorkspaceMeta>(this.workspaceMetaPath());
    if (meta?.defaultBoard && existsSync(this.boardPath(meta.defaultBoard))) {
      return meta.defaultBoard;
    }
    const boards = await this.listBoards();
    if (boards.length > 0) {
      return boards[0].slug;
    }
    return 'main';
  }

  public async setDefaultBoard(slug: string): Promise<void> {
    await ensureDir(this.deckDir);
    await writeYamlFile(this.workspaceMetaPath(), {
      defaultBoard: slugify(slug),
      updatedAt: nowIso(),
    });
  }

  public async resolveBoardSlug(boardSlug?: string): Promise<string> {
    if (boardSlug && boardSlug.trim()) {
      return slugify(boardSlug);
    }
    return this.getDefaultBoardSlug();
  }

  public async listBoards(): Promise<BoardConfig[]> {
    if (!existsSync(this.boardsDir)) return [];
    const entries = await fs.readdir(this.boardsDir, { withFileTypes: true });
    const configs: BoardConfig[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfg = await readYamlFile<Record<string, unknown>>(
        path.join(this.boardsDir, entry.name, 'board.yaml'),
      );
      if (cfg) {
        const parsed = BoardConfigSchema.safeParse(cfg);
        if (parsed.success) configs.push(parsed.data);
      }
    }
    return configs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async createBoard(
    input: {
      title: string;
      slug?: string;
      description?: string;
      brief?: string;
      lenses?: LensConfig[];
      setAsDefault?: boolean;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<BoardConfig> {
    const slug = slugify(input.slug ?? input.title);
    const dir = await this.ensureBoardDirs(slug);
    const now = nowIso();
    const config: BoardConfig = BoardConfigSchema.parse({
      id: shortId('brd'),
      slug,
      title: input.title,
      description: input.description ?? '',
      revision: 1,
      lenses: input.lenses ?? DEFAULT_LENSES,
      createdAt: now,
      updatedAt: now,
    });

    await writeYamlFile(path.join(dir, 'board.yaml'), config);
    const initialBrief =
      input.brief ??
      `# ${config.title}\n\n${config.description || 'Shared living mental model for this topic. Any connected agent session can read and update this brief as understanding evolves.'}\n`;
    await fs.writeFile(path.join(dir, 'brief.md'), initialBrief, 'utf8');
    await fs.writeFile(path.join(dir, 'events.jsonl'), '', 'utf8');

    await this.appendEvent(slug, {
      revision: 1,
      actor,
      kind: 'board.init',
      entityId: config.id,
      summary: `Created board "${config.title}"`,
    });

    const existing = await this.listBoards();
    if (input.setAsDefault || existing.length <= 1) {
      await this.setDefaultBoard(slug);
    }

    return config;
  }

  public async ensureDefaultBoard(title = 'Project Context'): Promise<BoardConfig> {
    const boards = await this.listBoards();
    if (boards.length > 0) {
      return boards[0];
    }
    return this.createBoard({ title, slug: 'main', setAsDefault: true });
  }

  private async readBoardConfig(slug: string): Promise<BoardConfig> {
    const cfg = await readYamlFile<Record<string, unknown>>(
      path.join(this.boardPath(slug), 'board.yaml'),
    );
    if (!cfg) {
      throw new Error(`Board "${slug}" does not exist in ${this.boardsDir}`);
    }
    return BoardConfigSchema.parse(cfg);
  }

  private async bumpRevision(slug: string): Promise<BoardConfig> {
    const cfg = await this.readBoardConfig(slug);
    const next: BoardConfig = {
      ...cfg,
      revision: cfg.revision + 1,
      updatedAt: nowIso(),
    };
    await writeYamlFile(path.join(this.boardPath(slug), 'board.yaml'), next);
    return next;
  }

  private async appendEvent(
    slug: string,
    input: {
      revision: number;
      actor: Actor;
      kind: string;
      entityId?: string;
      summary: string;
      details?: Record<string, unknown>;
    },
  ): Promise<BoardEvent> {
    const ev = BoardEventSchema.parse({
      id: shortId('evt'),
      revision: input.revision,
      timestamp: nowIso(),
      actor: input.actor,
      kind: input.kind,
      entityId: input.entityId,
      summary: input.summary,
      details: input.details,
    });
    const eventsPath = path.join(this.boardPath(slug), 'events.jsonl');
    await fs.appendFile(eventsPath, `${JSON.stringify(ev)}\n`, 'utf8');
    return ev;
  }

  public async readEvents(slug: string): Promise<BoardEvent[]> {
    const eventsPath = path.join(this.boardPath(slug), 'events.jsonl');
    try {
      const raw = await fs.readFile(eventsPath, 'utf8');
      const events: BoardEvent[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = BoardEventSchema.safeParse(JSON.parse(trimmed));
          if (parsed.success) events.push(parsed.data);
        } catch {
          // ignore malformed line
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  public async listSessions(slug: string): Promise<Session[]> {
    const dir = path.join(this.boardPath(slug), 'sessions');
    const files = await listFiles(dir, '.yaml');
    const out: Session[] = [];
    for (const file of files) {
      const raw = await readYamlFile<Record<string, unknown>>(path.join(dir, file));
      if (!raw) continue;
      const parsed = SessionSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async listDecisions(slug: string): Promise<Decision[]> {
    const dir = path.join(this.boardPath(slug), 'decisions');
    const files = await listFiles(dir, '.md');
    const out: Decision[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const { data, body } = parseFrontmatter<Record<string, unknown>>(raw);
      const parsed = DecisionSchema.safeParse({ ...data, rationale: body });
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  public async listTasks(slug: string): Promise<Task[]> {
    const dir = path.join(this.boardPath(slug), 'tasks');
    const files = await listFiles(dir, '.md');
    const out: Task[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const { data, body } = parseFrontmatter<Record<string, unknown>>(raw);
      const parsed = TaskSchema.safeParse({ ...data, description: body });
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  public async listDiagrams(slug: string): Promise<Diagram[]> {
    const dir = path.join(this.boardPath(slug), 'diagrams');
    const metaFiles = await listFiles(dir, '.meta.yaml');
    const out: Diagram[] = [];
    for (const metaFile of metaFiles) {
      const meta = await readYamlFile<Record<string, unknown>>(path.join(dir, metaFile));
      if (!meta) continue;
      const baseName = metaFile.replace(/\.meta\.yaml$/, '');
      const ext = meta.kind === 'excalidraw' ? '.excalidraw' : '.mmd';
      let content = '';
      try {
        content = await fs.readFile(path.join(dir, `${baseName}${ext}`), 'utf8');
      } catch {
        content = '';
      }
      const parsed = DiagramSchema.safeParse({ ...meta, content });
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async listMedia(slug: string): Promise<MediaArtifact[]> {
    const dir = path.join(this.boardPath(slug), 'media');
    const metaFiles = await listFiles(dir, '.meta.yaml');
    const out: MediaArtifact[] = [];
    for (const metaFile of metaFiles) {
      const meta = await readYamlFile<Record<string, unknown>>(path.join(dir, metaFile));
      if (!meta) continue;
      let content = typeof meta.content === 'string' ? meta.content : undefined;
      if (
        !content &&
        typeof meta.filePath === 'string' &&
        (meta.kind === 'doc' || meta.kind === 'html' || meta.kind === 'json')
      ) {
        try {
          content = await fs.readFile(path.join(dir, meta.filePath), 'utf8');
        } catch {
          // ignore missing content file
        }
      }
      const parsed = MediaArtifactSchema.safeParse({ ...meta, content });
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async listQuizzes(slug: string): Promise<Quiz[]> {
    const dir = path.join(this.boardPath(slug), 'quizzes');
    const files = await listFiles(dir, '.quiz.json');
    const out: Quiz[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const parsed = QuizSchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // ignore invalid quiz
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getSnapshot(boardSlug?: string): Promise<BoardSnapshot> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const config = await this.readBoardConfig(slug);
    let brief = '';
    try {
      brief = await fs.readFile(path.join(this.boardPath(slug), 'brief.md'), 'utf8');
    } catch {
      brief = '';
    }

    const [sessions, decisions, tasks, diagrams, media, quizzes, events] = await Promise.all([
      this.listSessions(slug),
      this.listDecisions(slug),
      this.listTasks(slug),
      this.listDiagrams(slug),
      this.listMedia(slug),
      this.listQuizzes(slug),
      this.readEvents(slug),
    ]);

    const drift = computeDriftReport({
      config,
      sessions,
      decisions,
      tasks,
      diagrams,
      media,
      quizzes,
      events,
    });

    return {
      config,
      brief,
      sessions,
      decisions,
      tasks,
      diagrams,
      media,
      quizzes,
      events,
      drift,
    };
  }

  public async updateBrief(
    boardSlug: string | undefined,
    brief: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<{ revision: number; brief: string }> {
    const slug = await this.resolveBoardSlug(boardSlug);
    await fs.writeFile(path.join(this.boardPath(slug), 'brief.md'), brief, 'utf8');
    const cfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: cfg.revision,
      actor,
      kind: 'brief.updated',
      summary: 'Updated living mental-model brief',
    });
    return { revision: cfg.revision, brief };
  }

  public async registerSession(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      harness?: string;
      externalRef?: string;
      parentSessionId?: string | null;
      relatedSessionIds?: string[];
      status?: SessionStatus;
      summary?: string;
      focusFiles?: string[];
      lastSyncedRevision?: number;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Session> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const cfg = await this.readBoardConfig(slug);
    const now = nowIso();
    const session = SessionSchema.parse({
      id: input.id ?? shortId('sess'),
      title: input.title,
      harness: input.harness ?? actor.harness ?? 'custom',
      externalRef: input.externalRef,
      parentSessionId: input.parentSessionId ?? null,
      relatedSessionIds: input.relatedSessionIds ?? [],
      status: input.status ?? 'active',
      summary: input.summary ?? '',
      focusFiles: input.focusFiles ?? [],
      lastSyncedRevision: input.lastSyncedRevision ?? cfg.revision,
      createdAt: now,
      updatedAt: now,
    });

    const filePath = path.join(this.boardPath(slug), 'sessions', `${session.id}.yaml`);
    await writeYamlFile(filePath, session);
    const nextCfg = await this.bumpRevision(slug);
    // Keep newly registered session synced unless explicitly backdated
    if (input.lastSyncedRevision === undefined) {
      session.lastSyncedRevision = nextCfg.revision;
      await writeYamlFile(filePath, session);
    }

    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor: { ...actor, harness: session.harness, sessionId: session.id },
      kind: 'session.registered',
      entityId: session.id,
      summary: `Registered ${session.harness} session "${session.title}"`,
    });

    return session;
  }

  public async updateSession(
    boardSlug: string | undefined,
    sessionId: string,
    patch: Partial<
      Pick<
        Session,
        | 'title'
        | 'harness'
        | 'externalRef'
        | 'parentSessionId'
        | 'relatedSessionIds'
        | 'status'
        | 'summary'
        | 'focusFiles'
        | 'lastSyncedRevision'
      >
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Session> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const filePath = path.join(this.boardPath(slug), 'sessions', `${sessionId}.yaml`);
    const existingRaw = await readYamlFile<Record<string, unknown>>(filePath);
    if (!existingRaw) {
      throw new Error(`Session "${sessionId}" not found on board "${slug}"`);
    }
    const existing = SessionSchema.parse(existingRaw);
    const updated = SessionSchema.parse({
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    });
    await writeYamlFile(filePath, updated);

    const nextCfg = await this.bumpRevision(slug);
    if (patch.lastSyncedRevision === undefined) {
      updated.lastSyncedRevision = nextCfg.revision;
      await writeYamlFile(filePath, updated);
    }

    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor: { ...actor, harness: updated.harness, sessionId: updated.id },
      kind: 'session.updated',
      entityId: updated.id,
      summary: `Updated session "${updated.title}" (${updated.status})`,
    });

    return updated;
  }

  public async syncSession(
    boardSlug: string | undefined,
    sessionId: string,
  ): Promise<{ session: Session; missedEvents: BoardEvent[]; currentRevision: number }> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const cfg = await this.readBoardConfig(slug);
    const filePath = path.join(this.boardPath(slug), 'sessions', `${sessionId}.yaml`);
    const existingRaw = await readYamlFile<Record<string, unknown>>(filePath);
    if (!existingRaw) {
      throw new Error(`Session "${sessionId}" not found on board "${slug}"`);
    }
    const existing = SessionSchema.parse(existingRaw);
    const events = await this.readEvents(slug);
    const missedEvents = events.filter((e) => e.revision > existing.lastSyncedRevision);
    const updated: Session = {
      ...existing,
      lastSyncedRevision: cfg.revision,
      updatedAt: nowIso(),
    };
    await writeYamlFile(filePath, updated);
    return { session: updated, missedEvents, currentRevision: cfg.revision };
  }

  public async deleteSession(
    boardSlug: string | undefined,
    sessionId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const filePath = path.join(this.boardPath(slug), 'sessions', `${sessionId}.yaml`);
    await fs.rm(filePath, { force: true });
    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'session.deleted',
      entityId: sessionId,
      summary: `Removed session ${sessionId}`,
    });
  }

  private decisionFilePath(slug: string, id: string): string {
    return path.join(this.boardPath(slug), 'decisions', `${id}.md`);
  }

  private async writeDecisionFile(slug: string, decision: Decision): Promise<void> {
    const { rationale, ...frontmatter } = decision;
    const raw = stringifyFrontmatter(frontmatter, rationale);
    await fs.writeFile(this.decisionFilePath(slug, decision.id), raw, 'utf8');
  }

  public async recordDecision(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      status?: DecisionStatus;
      supersedes?: string | null;
      sessionId?: string | null;
      tags?: string[];
      summary?: string;
      rationale?: string;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Decision> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const existing = await this.listDecisions(slug);
    const id = input.id ?? nextSequentialId('dec', existing.map((d) => d.id));
    const now = nowIso();

    const decision = DecisionSchema.parse({
      id,
      title: input.title,
      status: input.status ?? 'accepted',
      supersedes: input.supersedes ?? null,
      supersededBy: null,
      sessionId: input.sessionId ?? actor.sessionId ?? null,
      tags: input.tags ?? [],
      summary: input.summary ?? '',
      rationale: input.rationale ?? '',
      createdAt: now,
      updatedAt: now,
    });

    await this.writeDecisionFile(slug, decision);

    if (decision.supersedes) {
      const oldDecision = existing.find((d) => d.id === decision.supersedes);
      if (oldDecision) {
        const updatedOld: Decision = {
          ...oldDecision,
          status: 'superseded',
          supersededBy: decision.id,
          updatedAt: now,
        };
        await this.writeDecisionFile(slug, updatedOld);
      }
    }

    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: decision.supersedes ? 'decision.superseded' : 'decision.recorded',
      entityId: decision.id,
      summary: decision.supersedes
        ? `Recorded ${decision.id} ("${decision.title}"), superseding ${decision.supersedes}`
        : `Recorded ${decision.id} ("${decision.title}")`,
      details: decision.supersedes ? { supersedes: decision.supersedes } : undefined,
    });

    return decision;
  }

  public async updateDecision(
    boardSlug: string | undefined,
    decisionId: string,
    patch: Partial<
      Pick<Decision, 'title' | 'status' | 'summary' | 'rationale' | 'tags' | 'supersedes'>
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Decision> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const existingList = await this.listDecisions(slug);
    const existing = existingList.find((d) => d.id === decisionId);
    if (!existing) {
      throw new Error(`Decision "${decisionId}" not found on board "${slug}"`);
    }
    const updated = DecisionSchema.parse({
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    });
    await this.writeDecisionFile(slug, updated);
    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'decision.updated',
      entityId: updated.id,
      summary: `Updated decision ${updated.id} ("${updated.title}") [${updated.status}]`,
    });
    return updated;
  }

  private taskFilePath(slug: string, id: string): string {
    return path.join(this.boardPath(slug), 'tasks', `${id}.md`);
  }

  public async upsertTask(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      column?: TaskColumn;
      priority?: TaskPriority;
      assignee?: string;
      linkedSessionIds?: string[];
      linkedDecisionIds?: string[];
      tags?: string[];
      description?: string;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Task> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const existingList = await this.listTasks(slug);
    const existing = input.id ? existingList.find((t) => t.id === input.id) : undefined;
    const now = nowIso();

    const task = TaskSchema.parse({
      id: existing?.id ?? input.id ?? nextSequentialId('task', existingList.map((t) => t.id)),
      title: input.title,
      column: input.column ?? existing?.column ?? 'backlog',
      priority: input.priority ?? existing?.priority ?? 'medium',
      assignee: input.assignee ?? existing?.assignee ?? 'unassigned',
      linkedSessionIds: input.linkedSessionIds ?? existing?.linkedSessionIds ?? (actor.sessionId ? [actor.sessionId] : []),
      linkedDecisionIds: input.linkedDecisionIds ?? existing?.linkedDecisionIds ?? [],
      tags: input.tags ?? existing?.tags ?? [],
      description: input.description ?? existing?.description ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    const { description, ...frontmatter } = task;
    await fs.writeFile(
      this.taskFilePath(slug, task.id),
      stringifyFrontmatter(frontmatter, description),
      'utf8',
    );

    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: existing ? 'task.updated' : 'task.created',
      entityId: task.id,
      summary: existing
        ? `Updated ${task.id} ("${task.title}") → ${task.column}`
        : `Created ${task.id} ("${task.title}") in ${task.column}`,
    });

    return task;
  }

  public async deleteTask(
    boardSlug: string | undefined,
    taskId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    const slug = await this.resolveBoardSlug(boardSlug);
    await fs.rm(this.taskFilePath(slug, taskId), { force: true });
    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'task.deleted',
      entityId: taskId,
      summary: `Deleted task ${taskId}`,
    });
  }

  public async upsertDiagram(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      kind?: DiagramKind;
      content: string;
      description?: string;
      basedOnDecisions?: string[];
      sessionId?: string | null;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Diagram> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const cfg = await this.readBoardConfig(slug);
    const existingList = await this.listDiagrams(slug);
    const existing = input.id ? existingList.find((d) => d.id === input.id) : undefined;
    const now = nowIso();

    const kind = input.kind ?? existing?.kind ?? 'mermaid';
    const id = existing?.id ?? input.id ?? `diag_${slugify(input.title)}_${shortId('x').slice(2, 6)}`;
    const nextCfg = await this.bumpRevision(slug);

    const diagram = DiagramSchema.parse({
      id,
      title: input.title,
      kind,
      content: input.content,
      description: input.description ?? existing?.description ?? '',
      basedOnDecisions: input.basedOnDecisions ?? existing?.basedOnDecisions ?? [],
      sessionId: input.sessionId ?? actor.sessionId ?? existing?.sessionId ?? null,
      boardRevisionAtUpdate: nextCfg.revision || cfg.revision,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    const dir = path.join(this.boardPath(slug), 'diagrams');
    const ext = diagram.kind === 'excalidraw' ? '.excalidraw' : '.mmd';
    const { content, ...meta } = diagram;
    await fs.writeFile(path.join(dir, `${diagram.id}${ext}`), content, 'utf8');
    await writeYamlFile(path.join(dir, `${diagram.id}.meta.yaml`), meta);

    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: existing ? 'diagram.updated' : 'diagram.created',
      entityId: diagram.id,
      summary: `${existing ? 'Updated' : 'Created'} ${diagram.kind} diagram "${diagram.title}"`,
    });

    return diagram;
  }

  public async deleteDiagram(
    boardSlug: string | undefined,
    diagramId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const dir = path.join(this.boardPath(slug), 'diagrams');
    await Promise.all([
      fs.rm(path.join(dir, `${diagramId}.meta.yaml`), { force: true }),
      fs.rm(path.join(dir, `${diagramId}.mmd`), { force: true }),
      fs.rm(path.join(dir, `${diagramId}.excalidraw`), { force: true }),
    ]);
    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'diagram.deleted',
      entityId: diagramId,
      summary: `Deleted diagram ${diagramId}`,
    });
  }

  public async addMedia(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      kind: MediaKind;
      mimeType?: string;
      sourceFilePath?: string;
      fileBuffer?: Buffer;
      fileName?: string;
      externalUrl?: string;
      content?: string;
      transcript?: string;
      chapters?: Array<{ timeSec: number; title: string }>;
      durationSec?: number;
      tags?: string[];
      basedOnDecisions?: string[];
      sessionId?: string | null;
      customLensId?: string;
      metadata?: Record<string, unknown>;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<MediaArtifact> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const mediaDir = path.join(this.boardPath(slug), 'media');
    await ensureDir(mediaDir);

    const id = input.id ?? shortId('art');
    const now = nowIso();
    let storedFilePath: string | undefined;

    if (input.sourceFilePath) {
      const ext = path.extname(input.sourceFilePath);
      const targetName = `${id}${ext}`;
      await fs.copyFile(input.sourceFilePath, path.join(mediaDir, targetName));
      storedFilePath = targetName;
    } else if (input.fileBuffer) {
      const ext = input.fileName ? path.extname(input.fileName) : '';
      const targetName = `${id}${ext}`;
      await fs.writeFile(path.join(mediaDir, targetName), input.fileBuffer);
      storedFilePath = targetName;
    } else if (input.content && (input.kind === 'doc' || input.kind === 'html' || input.kind === 'json')) {
      const ext = input.kind === 'html' ? '.html' : input.kind === 'json' ? '.json' : '.md';
      const targetName = `${id}${ext}`;
      await fs.writeFile(path.join(mediaDir, targetName), input.content, 'utf8');
      storedFilePath = targetName;
    }

    const nextCfg = await this.bumpRevision(slug);
    const artifact = MediaArtifactSchema.parse({
      id,
      title: input.title,
      kind: input.kind,
      mimeType: input.mimeType,
      filePath: storedFilePath,
      externalUrl: input.externalUrl,
      content: input.content,
      transcript: input.transcript,
      chapters: input.chapters ?? [],
      durationSec: input.durationSec,
      tags: input.tags ?? [],
      basedOnDecisions: input.basedOnDecisions ?? [],
      sessionId: input.sessionId ?? actor.sessionId ?? null,
      boardRevisionAtUpdate: nextCfg.revision,
      customLensId: input.customLensId,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });

    const { content: _inlineContent, ...metaOnly } = artifact;
    await writeYamlFile(
      path.join(mediaDir, `${artifact.id}.meta.yaml`),
      storedFilePath ? metaOnly : artifact,
    );

    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'media.added',
      entityId: artifact.id,
      summary: `Attached ${artifact.kind} artifact "${artifact.title}"`,
    });

    return artifact;
  }

  public async updateMedia(
    boardSlug: string | undefined,
    mediaId: string,
    patch: Partial<
      Pick<
        MediaArtifact,
        | 'title'
        | 'content'
        | 'transcript'
        | 'chapters'
        | 'tags'
        | 'basedOnDecisions'
        | 'externalUrl'
        | 'metadata'
      >
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<MediaArtifact> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const list = await this.listMedia(slug);
    const existing = list.find((m) => m.id === mediaId);
    if (!existing) {
      throw new Error(`Media artifact "${mediaId}" not found on board "${slug}"`);
    }
    const nextCfg = await this.bumpRevision(slug);
    const updated = MediaArtifactSchema.parse({
      ...existing,
      ...patch,
      boardRevisionAtUpdate: nextCfg.revision,
      updatedAt: nowIso(),
    });

    const mediaDir = path.join(this.boardPath(slug), 'media');
    if (patch.content !== undefined && updated.filePath) {
      await fs.writeFile(path.join(mediaDir, updated.filePath), patch.content, 'utf8');
    }
    const { content: _inlineContent, ...metaOnly } = updated;
    await writeYamlFile(
      path.join(mediaDir, `${updated.id}.meta.yaml`),
      updated.filePath ? metaOnly : updated,
    );

    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'media.updated',
      entityId: updated.id,
      summary: `Updated ${updated.kind} artifact "${updated.title}"`,
    });

    return updated;
  }

  public async deleteMedia(
    boardSlug: string | undefined,
    mediaId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const list = await this.listMedia(slug);
    const existing = list.find((m) => m.id === mediaId);
    const mediaDir = path.join(this.boardPath(slug), 'media');
    await fs.rm(path.join(mediaDir, `${mediaId}.meta.yaml`), { force: true });
    if (existing?.filePath) {
      await fs.rm(path.join(mediaDir, existing.filePath), { force: true });
    }
    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'media.deleted',
      entityId: mediaId,
      summary: `Removed media artifact ${mediaId}`,
    });
  }

  public async resolveMediaFilePath(
    boardSlug: string | undefined,
    mediaId: string,
  ): Promise<{ absolutePath: string; artifact: MediaArtifact } | null> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const list = await this.listMedia(slug);
    const artifact = list.find((m) => m.id === mediaId);
    if (!artifact?.filePath) return null;
    const absolutePath = path.join(this.boardPath(slug), 'media', artifact.filePath);
    if (!existsSync(absolutePath)) return null;
    return { absolutePath, artifact };
  }

  public async createQuiz(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      topic?: string;
      description?: string;
      questions: QuizQuestion[];
      basedOnDecisions?: string[];
      sessionId?: string | null;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Quiz> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const nextCfg = await this.bumpRevision(slug);
    const now = nowIso();
    const quiz = QuizSchema.parse({
      id: input.id ?? shortId('quiz'),
      title: input.title,
      topic: input.topic ?? '',
      description: input.description ?? '',
      questions: input.questions,
      attempts: [],
      basedOnDecisions: input.basedOnDecisions ?? [],
      sessionId: input.sessionId ?? actor.sessionId ?? null,
      boardRevisionAtUpdate: nextCfg.revision,
      createdAt: now,
      updatedAt: now,
    });

    await fs.writeFile(
      path.join(this.boardPath(slug), 'quizzes', `${quiz.id}.quiz.json`),
      `${JSON.stringify(quiz, null, 2)}\n`,
      'utf8',
    );

    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'quiz.created',
      entityId: quiz.id,
      summary: `Created knowledge check quiz "${quiz.title}" (${quiz.questions.length} questions)`,
    });

    return quiz;
  }

  public async submitQuizAttempt(
    boardSlug: string | undefined,
    quizId: string,
    input: {
      answers: Record<string, number | string | boolean>;
      confidence?: number;
    },
    actor: Actor = { type: 'human', label: 'user' },
  ): Promise<{ quiz: Quiz; attempt: QuizAttempt }> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const quizPath = path.join(this.boardPath(slug), 'quizzes', `${quizId}.quiz.json`);
    const raw = await fs.readFile(quizPath, 'utf8');
    const quiz = QuizSchema.parse(JSON.parse(raw));

    let score = 0;
    for (const q of quiz.questions) {
      const userAnswer = input.answers[q.id];
      if (q.type === 'multiple_choice' && typeof q.correctIndex === 'number') {
        if (Number(userAnswer) === q.correctIndex) score += 1;
      } else if (q.type === 'true_false' && q.correctAnswer !== undefined) {
        if (String(userAnswer).toLowerCase() === q.correctAnswer.toLowerCase()) score += 1;
      } else if (q.type === 'short_answer' && q.correctAnswer) {
        if (
          typeof userAnswer === 'string' &&
          userAnswer.trim().toLowerCase().includes(q.correctAnswer.trim().toLowerCase())
        ) {
          score += 1;
        }
      }
    }

    const total = quiz.questions.length;
    const percentage = Math.round((score / total) * 100);
    const attempt = QuizAttemptSchema.parse({
      id: shortId('att'),
      takenAt: nowIso(),
      score,
      total,
      percentage,
      confidence: input.confidence,
      answers: input.answers,
    });

    const updatedQuiz: Quiz = {
      ...quiz,
      attempts: [...quiz.attempts, attempt],
      updatedAt: nowIso(),
    };

    await fs.writeFile(quizPath, `${JSON.stringify(updatedQuiz, null, 2)}\n`, 'utf8');
    const nextCfg = await this.bumpRevision(slug);
    await this.appendEvent(slug, {
      revision: nextCfg.revision,
      actor,
      kind: 'quiz.attempted',
      entityId: quiz.id,
      summary: `Completed quiz "${quiz.title}" — ${score}/${total} (${percentage}%)`,
    });

    return { quiz: updatedQuiz, attempt };
  }

  public async refreshArtifactDecisions(
    boardSlug: string | undefined,
    artifactType: 'diagram' | 'media' | 'quiz' | 'task',
    artifactId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const decisions = await this.listDecisions(slug);
    const map = new Map(decisions.map((d) => [d.id, d]));

    const upgradeDecisionIds = (ids: string[]): string[] => {
      const next = new Set<string>();
      for (const id of ids) {
        let cur = map.get(id);
        const seen = new Set<string>();
        while (cur?.supersededBy && !seen.has(cur.id)) {
          seen.add(cur.id);
          const replacement = map.get(cur.supersededBy);
          if (!replacement) break;
          cur = replacement;
        }
        if (cur && cur.status !== 'deprecated') {
          next.add(cur.id);
        }
      }
      return Array.from(next);
    };

    if (artifactType === 'diagram') {
      const list = await this.listDiagrams(slug);
      const item = list.find((d) => d.id === artifactId);
      if (!item) throw new Error(`Diagram "${artifactId}" not found`);
      await this.upsertDiagram(
        slug,
        {
          id: item.id,
          title: item.title,
          kind: item.kind,
          content: item.content,
          description: item.description,
          basedOnDecisions: upgradeDecisionIds(item.basedOnDecisions),
        },
        actor,
      );
      return;
    }

    if (artifactType === 'media') {
      const list = await this.listMedia(slug);
      const item = list.find((m) => m.id === artifactId);
      if (!item) throw new Error(`Media "${artifactId}" not found`);
      await this.updateMedia(
        slug,
        artifactId,
        { basedOnDecisions: upgradeDecisionIds(item.basedOnDecisions) },
        actor,
      );
      return;
    }

    if (artifactType === 'task') {
      const list = await this.listTasks(slug);
      const item = list.find((t) => t.id === artifactId);
      if (!item) throw new Error(`Task "${artifactId}" not found`);
      await this.upsertTask(
        slug,
        {
          id: item.id,
          title: item.title,
          linkedDecisionIds: upgradeDecisionIds(item.linkedDecisionIds),
        },
        actor,
      );
      return;
    }

    if (artifactType === 'quiz') {
      const quizPath = path.join(this.boardPath(slug), 'quizzes', `${artifactId}.quiz.json`);
      const raw = await fs.readFile(quizPath, 'utf8');
      const quiz = QuizSchema.parse(JSON.parse(raw));
      const nextCfg = await this.bumpRevision(slug);
      const updated: Quiz = {
        ...quiz,
        basedOnDecisions: upgradeDecisionIds(quiz.basedOnDecisions),
        boardRevisionAtUpdate: nextCfg.revision,
        updatedAt: nowIso(),
      };
      await fs.writeFile(quizPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      await this.appendEvent(slug, {
        revision: nextCfg.revision,
        actor,
        kind: 'artifact.refreshed',
        entityId: quiz.id,
        summary: `Marked quiz "${quiz.title}" aligned with latest decisions`,
      });
    }
  }

  public async applyContextUpdate(
    boardSlug: string | undefined,
    payload: ContextUpdatePayload,
    actor: Actor = { type: 'agent', label: 'web-chat' },
  ): Promise<{ appliedCount: number; sessionId?: string; snapshot: BoardSnapshot }> {
    const slug = await this.resolveBoardSlug(boardSlug);
    let appliedCount = 0;
    let activeSessionId = payload.sessionId;
    const effectiveActor: Actor = {
      ...actor,
      harness: payload.harness ?? actor.harness ?? 'web-chat',
    };

    if (payload.sessionId) {
      const sessions = await this.listSessions(slug);
      const found = sessions.find((s) => s.id === payload.sessionId);
      if (found) {
        await this.updateSession(
          slug,
          found.id,
          { summary: payload.sessionSummary ?? found.summary },
          effectiveActor,
        );
        appliedCount += 1;
      }
    } else if (payload.sessionTitle) {
      const created = await this.registerSession(
        slug,
        {
          title: payload.sessionTitle,
          harness: payload.harness ?? 'grok',
          summary: payload.sessionSummary ?? '',
        },
        effectiveActor,
      );
      activeSessionId = created.id;
      appliedCount += 1;
    }

    const withSessionActor: Actor = { ...effectiveActor, sessionId: activeSessionId };

    if (payload.brief) {
      await this.updateBrief(slug, payload.brief, withSessionActor);
      appliedCount += 1;
    }

    for (const dec of payload.decisions ?? []) {
      await this.recordDecision(slug, { ...dec, sessionId: activeSessionId }, withSessionActor);
      appliedCount += 1;
    }

    for (const task of payload.tasks ?? []) {
      await this.upsertTask(
        slug,
        {
          ...task,
          linkedSessionIds: activeSessionId ? [activeSessionId] : undefined,
        },
        withSessionActor,
      );
      appliedCount += 1;
    }

    for (const diag of payload.diagrams ?? []) {
      await this.upsertDiagram(slug, { ...diag, sessionId: activeSessionId }, withSessionActor);
      appliedCount += 1;
    }

    for (const quiz of payload.quizzes ?? []) {
      await this.createQuiz(slug, { ...quiz, sessionId: activeSessionId }, withSessionActor);
      appliedCount += 1;
    }

    const snapshot = await this.getSnapshot(slug);
    return { appliedCount, sessionId: activeSessionId, snapshot };
  }

  public watch(onChange: (boardSlug: string | null, changedPath: string) => void): FSWatcher {
    let timer: NodeJS.Timeout | null = null;
    const watcher = chokidar.watch(this.deckDir, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\.cache([/\\]|$)/,
    });

    const trigger = (filePath: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const rel = path.relative(this.boardsDir, filePath);
        const parts = rel.split(path.sep);
        const slug = parts.length > 0 && !parts[0].startsWith('..') ? parts[0] : null;
        onChange(slug, filePath);
      }, 150);
    };

    watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
    return watcher;
  }
}
