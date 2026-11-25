import type {
  BoardConfig,
  BoardEvent,
  Decision,
  Diagram,
  DriftReport,
  DriftedSessionNotice,
  MediaArtifact,
  Quiz,
  Session,
  StaleArtifactNotice,
  Task,
} from './schemas.js';

export function resolveLatestDecision(
  decisionId: string,
  decisionMap: Map<string, Decision>,
): Decision | undefined {
  let current = decisionMap.get(decisionId);
  const visited = new Set<string>();
  while (current?.supersededBy && !visited.has(current.id)) {
    visited.add(current.id);
    const next = decisionMap.get(current.supersededBy);
    if (!next) break;
    current = next;
  }
  return current;
}

export function computeDriftReport(params: {
  config: BoardConfig;
  sessions: Session[];
  decisions: Decision[];
  tasks: Task[];
  diagrams: Diagram[];
  media: MediaArtifact[];
  quizzes: Quiz[];
  events: BoardEvent[];
}): DriftReport {
  const { config, sessions, decisions, tasks, diagrams, media, quizzes, events } = params;
  const decisionMap = new Map(decisions.map((d) => [d.id, d]));

  const evaluateDecisions = (decisionIds: string[]): { staleIds: string[]; reasons: string[] } => {
    const staleIds: string[] = [];
    const reasons: string[] = [];
    for (const decId of decisionIds) {
      const dec = decisionMap.get(decId);
      if (!dec) continue;
      if (dec.status === 'superseded') {
        staleIds.push(dec.id);
        const latest = resolveLatestDecision(dec.id, decisionMap);
        if (latest && latest.id !== dec.id) {
          reasons.push(`${dec.id} ("${dec.title}") was superseded by ${latest.id} ("${latest.title}")`);
        } else {
          reasons.push(`${dec.id} ("${dec.title}") was superseded`);
        }
      } else if (dec.status === 'deprecated') {
        staleIds.push(dec.id);
        reasons.push(`${dec.id} ("${dec.title}") was deprecated`);
      }
    }
    return { staleIds, reasons };
  };

  const staleArtifacts: StaleArtifactNotice[] = [];

  for (const diag of diagrams) {
    const { staleIds, reasons } = evaluateDecisions(diag.basedOnDecisions);
    if (staleIds.length > 0) {
      staleArtifacts.push({
        artifactType: 'diagram',
        artifactId: diag.id,
        title: diag.title,
        staleDecisionIds: staleIds,
        reasons,
      });
    }
  }

  for (const item of media) {
    const { staleIds, reasons } = evaluateDecisions(item.basedOnDecisions);
    if (staleIds.length > 0) {
      staleArtifacts.push({
        artifactType: 'media',
        artifactId: item.id,
        title: item.title,
        staleDecisionIds: staleIds,
        reasons,
      });
    }
  }

  for (const quiz of quizzes) {
    const { staleIds, reasons } = evaluateDecisions(quiz.basedOnDecisions);
    if (staleIds.length > 0) {
      staleArtifacts.push({
        artifactType: 'quiz',
        artifactId: quiz.id,
        title: quiz.title,
        staleDecisionIds: staleIds,
        reasons,
      });
    }
  }

  for (const task of tasks) {
    if (task.column === 'done') continue;
    const { staleIds, reasons } = evaluateDecisions(task.linkedDecisionIds);
    if (staleIds.length > 0) {
      staleArtifacts.push({
        artifactType: 'task',
        artifactId: task.id,
        title: task.title,
        staleDecisionIds: staleIds,
        reasons,
      });
    }
  }

  const driftedSessions: DriftedSessionNotice[] = [];
  for (const session of sessions) {
    if (session.status === 'archived' || session.status === 'completed') continue;
    if (session.lastSyncedRevision < config.revision) {
      const missedEvents = events.filter((e) => e.revision > session.lastSyncedRevision);
      driftedSessions.push({
        sessionId: session.id,
        title: session.title,
        harness: session.harness,
        lastSyncedRevision: session.lastSyncedRevision,
        currentRevision: config.revision,
        behindBy: config.revision - session.lastSyncedRevision,
        missedEvents,
      });
    }
  }

  return {
    currentRevision: config.revision,
    staleArtifacts,
    driftedSessions,
  };
}
