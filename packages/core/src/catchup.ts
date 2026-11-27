import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { capSingleLine, isMeaningfulEvent, resolveLatestDecision } from './drift.js';
import { nowIso, validateEntityId } from './ids.js';
import type {
  BoardConfig,
  BoardEvent,
  CatchUpDecisionChange,
  CatchUpNewSession,
  CatchUpOtherChange,
  CatchUpReport,
  CatchUpStaleArtifact,
  CatchUpTaskMove,
  Decision,
  Diagram,
  MediaArtifact,
  PublicRefreshJob,
  Quiz,
  ReaderBoardCursor,
  Session,
  StaleArtifactNotice,
  Task,
  TaskColumn,
} from './schemas.js';

const MAX_OTHER_CHANGES = 20;

// H13 / Claude N1: Memoize git config identity per projectRoot for the process lifetime
// so GET /catchup, POST /reader/ack, and POST /confirm never block the event loop repeatedly.
const gitEmailCache = new Map<string, string | null>();
const gitNameCache = new Map<string, string | null>();

function getMemoizedGitConfig(
  key: 'user.email' | 'user.name',
  projectRoot: string | undefined,
): string | null {
  const cacheKey = projectRoot ?? '';
  const cache = key === 'user.email' ? gitEmailCache : gitNameCache;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }
  let value: string | null = null;
  try {
    const out = execFileSync('git', ['config', key], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) value = out;
  } catch {
    value = null;
  }
  cache.set(cacheKey, value);
  return value;
}

/**
 * Derive a deterministic, filename-safe per-human reader ID (AC7.1, D16).
 * Uses SHA-256 of `git config user.email` (when available) or the OS username,
 * so raw emails/usernames never appear in filenames or committed files (C3).
 */
export function resolveDefaultReaderId(options: {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.CONTEXTDECK_READER?.trim();
  if (explicit) {
    try {
      return validateEntityId(explicit, 'readerId');
    } catch {
      const hash = crypto.createHash('sha256').update(explicit).digest('hex').slice(0, 16);
      return `reader_${hash}`;
    }
  }

  const email = getMemoizedGitConfig('user.email', options.projectRoot);
  let identity = email ? email.toLowerCase() : '';

  if (!identity) {
    try {
      identity = os.userInfo().username || env.USER || env.USERNAME || 'local';
    } catch {
      identity = env.USER || env.USERNAME || 'local';
    }
  }

  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return `reader_${hash}`;
}

export function resolveDefaultReaderLabel(options: {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.CONTEXTDECK_READER_LABEL?.trim();
  if (explicit) return capSingleLine(explicit, 80);

  const name = getMemoizedGitConfig('user.name', options.projectRoot);
  if (name) return capSingleLine(name, 80);

  try {
    const user = os.userInfo().username || env.USER || env.USERNAME;
    if (user) return capSingleLine(user, 80);
  } catch {
    // fallback
  }

  return 'human';
}

function firstRationaleLine(summary: string, rationale: string): string {
  if (summary.trim()) return capSingleLine(summary, 180);
  const firstLine = rationale
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return firstLine ? capSingleLine(firstLine, 180) : '';
}

const VALID_COLUMNS = new Set<TaskColumn>(['backlog', 'in_progress', 'in_review', 'done']);

function parseTaskColumn(value: unknown): TaskColumn | null {
  return typeof value === 'string' && VALID_COLUMNS.has(value as TaskColumn)
    ? (value as TaskColumn)
    : null;
}

export interface CatchUpSourceData {
  config: Pick<BoardConfig, 'revision'>;
  sessions: Array<Pick<Session, 'id' | 'title' | 'harness' | 'createdAt'>>;
  decisions: Decision[];
  tasks: Task[];
  diagrams: Array<Pick<Diagram, 'id' | 'version' | 'boardRevisionAtUpdate'>>;
  media: Array<Pick<MediaArtifact, 'id' | 'version' | 'boardRevisionAtUpdate'>>;
  quizzes: Array<Pick<Quiz, 'id' | 'version' | 'boardRevisionAtUpdate'>>;
  jobs?: PublicRefreshJob[];
  events: BoardEvent[];
  drift: {
    staleArtifacts: StaleArtifactNotice[];
  };
}

/**
 * Compute the human "Catch up" report between a reader's cursor and the board's current revision (AC7.2, D16).
 */
export function computeCatchUp(
  snapshot: CatchUpSourceData,
  cursor: ReaderBoardCursor | null,
  options: { evaluatedAt?: string } = {},
): CatchUpReport {
  const evaluatedAt = options.evaluatedAt ?? nowIso();
  const fromRevision = cursor?.lastReviewedRevision ?? 0;
  const toRevision = snapshot.config.revision;
  const lastReviewedAt = cursor?.lastReviewedAt ?? null;

  const windowEvents = snapshot.events
    .filter((ev) => ev.revision > fromRevision && ev.revision <= toRevision)
    .sort((a, b) => a.revision - b.revision);

  const decisionMap = new Map(snapshot.decisions.map((d) => [d.id, d]));
  const taskMap = new Map(snapshot.tasks.map((t) => [t.id, t]));

  // 1. Decisions changed in window
  const rawDecChanges = new Map<string, CatchUpDecisionChange>();
  const supersededInWindow = new Set<string>();
  const changedDecisionIds = new Set<string>();
  const representedDecisionEventIds = new Set<string>();

  for (const ev of windowEvents) {
    if (
      ev.kind !== 'decision.recorded' &&
      ev.kind !== 'decision.superseded' &&
      ev.kind !== 'decision.updated'
    ) {
      continue;
    }
    if (!ev.entityId) continue;
    const dec = decisionMap.get(ev.entityId);
    if (!dec) continue;
    representedDecisionEventIds.add(ev.id);
    changedDecisionIds.add(dec.id);

    const supersedesId =
      (typeof ev.details?.supersedes === 'string' ? ev.details.supersedes : null) ??
      dec.supersedes ??
      null;
    const prevDec = supersedesId ? decisionMap.get(supersedesId) : undefined;
    const beforeObj =
      ev.details?.before && typeof ev.details.before === 'object'
        ? (ev.details.before as { id?: unknown; title?: unknown })
        : null;
    const previousDecisionId =
      supersedesId ?? (typeof beforeObj?.id === 'string' && beforeObj.id !== dec.id ? beforeObj.id : undefined);
    const previousTitle =
      prevDec?.title ??
      (previousDecisionId && typeof beforeObj?.title === 'string' ? beforeObj.title : undefined);

    if (previousDecisionId) {
      supersededInWindow.add(previousDecisionId);
      changedDecisionIds.add(previousDecisionId);
    }

    const existing = rawDecChanges.get(dec.id);
    rawDecChanges.set(dec.id, {
      decisionId: dec.id,
      title: dec.title,
      status: dec.status,
      summary: dec.summary,
      rationaleLine: firstRationaleLine(dec.summary, dec.rationale),
      previousDecisionId: previousDecisionId ?? existing?.previousDecisionId,
      previousTitle: previousTitle ?? existing?.previousTitle,
      revision: ev.revision,
      timestamp: ev.timestamp,
    });
  }

  // Drop redundant standalone entries for decisions that were superseded in the same window,
  // and walk `supersedes` backward past in-window intermediates to the pre-window decision (H12).
  const decisionsChanged = Array.from(rawDecChanges.values())
    .filter((entry) => !supersededInWindow.has(entry.decisionId))
    .map((entry) => {
      let prevId = entry.previousDecisionId;
      let prevTitle = entry.previousTitle;
      const visited = new Set<string>([entry.decisionId]);
      while (prevId && !visited.has(prevId)) {
        visited.add(prevId);
        if (!rawDecChanges.has(prevId)) {
          break;
        }
        const prevDec = decisionMap.get(prevId);
        const earlierId = prevDec?.supersedes ?? rawDecChanges.get(prevId)?.previousDecisionId;
        if (!earlierId || visited.has(earlierId)) {
          break;
        }
        const earlierDec = decisionMap.get(earlierId);
        prevId = earlierId;
        prevTitle = earlierDec?.title ?? rawDecChanges.get(earlierId)?.previousTitle ?? earlierId;
      }
      return {
        ...entry,
        ...(prevId !== undefined ? { previousDecisionId: prevId } : {}),
        ...(prevTitle !== undefined ? { previousTitle: prevTitle } : {}),
      };
    })
    .sort((a, b) => a.revision - b.revision);

  // 2. Artifacts now out of date (diagram, media, quiz only — D17 tasks are not refresh targets)
  const openJobByKey = new Map<string, { id: string; status: 'queued' | 'claimed'; claimedBy: string | null }>();
  for (const job of snapshot.jobs ?? []) {
    if (job.status === 'queued' || job.status === 'claimed') {
      openJobByKey.set(`${job.artifactType}:${job.artifactId}`, {
        id: job.id,
        status: job.status,
        claimedBy: job.claimedBy,
      });
    }
  }

  const artifactRevMap = new Map<string, number>();
  const artifactVersionMap = new Map<string, number>();
  for (const d of snapshot.diagrams) {
    artifactRevMap.set(`diagram:${d.id}`, d.boardRevisionAtUpdate);
    artifactVersionMap.set(`diagram:${d.id}`, d.version);
  }
  for (const m of snapshot.media) {
    artifactRevMap.set(`media:${m.id}`, m.boardRevisionAtUpdate);
    artifactVersionMap.set(`media:${m.id}`, m.version);
  }
  for (const q of snapshot.quizzes) {
    artifactRevMap.set(`quiz:${q.id}`, q.boardRevisionAtUpdate);
    artifactVersionMap.set(`quiz:${q.id}`, q.version);
  }

  const staleArtifacts: CatchUpStaleArtifact[] = [];
  if (fromRevision < toRevision) {
    for (const notice of snapshot.drift.staleArtifacts) {
      if (notice.artifactType === 'task') continue;
      const key = `${notice.artifactType}:${notice.artifactId}`;
      const artRev = artifactRevMap.get(key) ?? 0;

      const decisionTriggered = notice.staleDecisionIds.some((staleDecId) => {
        if (changedDecisionIds.has(staleDecId)) return true;
        const latest = resolveLatestDecision(staleDecId, decisionMap);
        return latest ? changedDecisionIds.has(latest.id) : false;
      });

      if (fromRevision === 0 || decisionTriggered || artRev > fromRevision) {
        const expectedAgainst: Record<string, string> = {};
        if (notice.expectedAgainst) {
          Object.assign(expectedAgainst, notice.expectedAgainst);
        } else {
          for (const staleId of notice.staleDecisionIds) {
            const dec = decisionMap.get(staleId);
            const latest =
              dec?.status === 'superseded' ? resolveLatestDecision(dec.id, decisionMap) : dec;
            expectedAgainst[staleId] = latest?.id ?? staleId;
          }
        }
        staleArtifacts.push({
          artifactType: notice.artifactType,
          artifactId: notice.artifactId,
          title: notice.title,
          artifactVersion: notice.artifactVersion ?? artifactVersionMap.get(key) ?? 1,
          staleDecisionIds: notice.staleDecisionIds,
          expectedAgainst,
          reasons: notice.reasons,
          activeJob: openJobByKey.get(key) ?? null,
        });
      }
    }
  }

  // 3. Tasks moved (or created) in window
  const taskTrack = new Map<
    string,
    {
      title: string;
      fromColumn: TaskColumn | null;
      toColumn: TaskColumn;
      revision: number;
      created: boolean;
      eventIds: string[];
    }
  >();
  const deletedTasks = new Set<string>();
  for (const ev of windowEvents) {
    if (!ev.entityId) continue;
    if (ev.kind === 'task.deleted') {
      deletedTasks.add(ev.entityId);
      taskTrack.delete(ev.entityId);
      continue;
    }
    if (ev.kind !== 'task.created' && ev.kind !== 'task.updated') continue;
    deletedTasks.delete(ev.entityId);

    const beforeObj =
      ev.details?.before && typeof ev.details.before === 'object'
        ? (ev.details.before as { column?: unknown; title?: unknown })
        : null;
    const afterObj =
      ev.details?.after && typeof ev.details.after === 'object'
        ? (ev.details.after as { column?: unknown; title?: unknown })
        : null;

    const currentTask = taskMap.get(ev.entityId);
    const toCol = parseTaskColumn(afterObj?.column) ?? currentTask?.column ?? 'backlog';
    const fromCol = ev.kind === 'task.created' ? null : parseTaskColumn(beforeObj?.column);
    const title =
      currentTask?.title ??
      (typeof afterObj?.title === 'string' ? afterObj.title : ev.entityId);

    const prev = taskTrack.get(ev.entityId);
    if (!prev) {
      taskTrack.set(ev.entityId, {
        title,
        fromColumn: fromCol,
        toColumn: toCol,
        revision: ev.revision,
        created: ev.kind === 'task.created',
        eventIds: [ev.id],
      });
    } else {
      prev.title = title;
      prev.toColumn = toCol;
      prev.revision = ev.revision;
      prev.eventIds.push(ev.id);
    }
  }

  const tasksMoved: CatchUpTaskMove[] = [];
  const representedTaskEventIds = new Set<string>();
  for (const [taskId, info] of taskTrack.entries()) {
    if (deletedTasks.has(taskId)) continue;
    if (info.created || (info.fromColumn !== null && info.fromColumn !== info.toColumn)) {
      tasksMoved.push({
        taskId,
        title: info.title,
        fromColumn: info.fromColumn,
        toColumn: info.toColumn,
        revision: info.revision,
      });
      for (const evId of info.eventIds) {
        representedTaskEventIds.add(evId);
      }
    }
  }
  tasksMoved.sort((a, b) => a.revision - b.revision);

  // 4. New sessions (from session.registered events OR hook-created sessions after lastReviewedAt)
  const registeredEventSessionIds = new Set<string>();
  for (const ev of windowEvents) {
    if (ev.kind === 'session.registered' && ev.entityId) {
      registeredEventSessionIds.add(ev.entityId);
    }
  }

  const newSessions: CatchUpNewSession[] = [];
  let hookOnlyNewSessions = 0;
  for (const s of snapshot.sessions) {
    const viaEvent = registeredEventSessionIds.has(s.id);
    const viaTimestamp =
      lastReviewedAt === null
        ? fromRevision === 0
        : Date.parse(s.createdAt) > Date.parse(lastReviewedAt);
    if (viaEvent || viaTimestamp) {
      newSessions.push({
        sessionId: s.id,
        title: s.title,
        harness: s.harness,
        createdAt: s.createdAt,
      });
      if (!viaEvent && lastReviewedAt !== null) {
        hookOnlyNewSessions += 1;
      }
    }
  }
  newSessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // 5. Other meaningful changes not covered by Decisions / Tasks moved (H11: brief updates,
  // diagram/media/quiz updates, confirmations, job changes, task edits/deletes, board updates).
  const allOtherChanges: CatchUpOtherChange[] = [];
  for (const ev of windowEvents) {
    if (!isMeaningfulEvent(ev.kind) || ev.kind === 'board.init') continue;
    if (decisionsChanged.length > 0 && representedDecisionEventIds.has(ev.id)) continue;
    if (representedTaskEventIds.has(ev.id)) continue;
    allOtherChanges.push({
      kind: ev.kind,
      title: capSingleLine(ev.summary, 160),
      actor: capSingleLine(ev.actor.label ?? ev.actor.harness ?? ev.actor.type, 60),
      at: ev.timestamp,
    });
  }
  const otherChanges = allOtherChanges.slice(0, MAX_OTHER_CHANGES);
  const otherChangesTruncated = Math.max(0, allOtherChanges.length - MAX_OTHER_CHANGES);

  // Count meaningful changes since last look (excluding initial board.init)
  const meaningfulEventsCount = windowEvents.filter(
    (ev) => isMeaningfulEvent(ev.kind) && ev.kind !== 'board.init',
  ).length;

  const unseenCount = meaningfulEventsCount + hookOnlyNewSessions;
  const hasUnseen =
    unseenCount > 0 ||
    decisionsChanged.length > 0 ||
    staleArtifacts.length > 0 ||
    tasksMoved.length > 0 ||
    newSessions.length > 0 ||
    otherChanges.length > 0;

  return {
    fromRevision,
    toRevision,
    lastReviewedAt,
    evaluatedAt,
    unseenCount: unseenCount > 0 ? unseenCount : hasUnseen ? newSessions.length : 0,
    hasUnseen,
    decisionsChanged,
    staleArtifacts,
    tasksMoved,
    newSessions,
    otherChanges,
    otherChangesTruncated,
  };
}
