import {
  ContextUpdatePayloadSchema,
  type BoardSnapshot,
  type ContextUpdatePayload,
} from './schemas.js';

export interface ContextPackOptions {
  includeUpdateProtocol?: boolean;
  maxRecentEvents?: number;
}

export function generateContextPack(
  snapshot: BoardSnapshot,
  options: ContextPackOptions = {},
): string {
  const { includeUpdateProtocol = true, maxRecentEvents = 8 } = options;
  const lines: string[] = [];

  lines.push(`# ContextDeck Shared Context: ${snapshot.config.title}`);
  lines.push(
    `> Board: \`${snapshot.config.slug}\` | Revision: \`rev ${snapshot.config.revision}\` | Updated: ${snapshot.config.updatedAt}`,
  );
  lines.push('');

  if (snapshot.brief.trim()) {
    lines.push('## Living Brief (Current Mental Model)');
    lines.push(snapshot.brief.trim());
    lines.push('');
  }

  const acceptedDecisions = snapshot.decisions.filter((d) => d.status === 'accepted');
  const proposedDecisions = snapshot.decisions.filter((d) => d.status === 'proposed');
  const supersededDecisions = snapshot.decisions.filter((d) => d.status === 'superseded');

  lines.push('## Active Decisions');
  if (acceptedDecisions.length === 0) {
    lines.push('_No accepted decisions yet._');
  } else {
    for (const d of acceptedDecisions) {
      lines.push(`- **${d.id} — ${d.title}**${d.summary ? `: ${d.summary}` : ''}`);
    }
  }
  if (proposedDecisions.length > 0) {
    lines.push('');
    lines.push('### Proposed Decisions');
    for (const d of proposedDecisions) {
      lines.push(`- **${d.id} — ${d.title}**${d.summary ? `: ${d.summary}` : ''}`);
    }
  }
  if (supersededDecisions.length > 0) {
    lines.push('');
    lines.push('### Recently Superseded (Do Not Use)');
    for (const d of supersededDecisions.slice(-5)) {
      lines.push(
        `- ~~${d.id} — ${d.title}~~${d.supersededBy ? ` (replaced by **${d.supersededBy}**)` : ''}`,
      );
    }
  }
  lines.push('');

  const openTasks = snapshot.tasks.filter((t) => t.column !== 'done');
  lines.push('## Open Tasks');
  if (openTasks.length === 0) {
    lines.push('_No open tasks._');
  } else {
    for (const t of openTasks) {
      lines.push(
        `- [${t.column}] **${t.id}** (${t.priority}) ${t.title}${t.assignee !== 'unassigned' ? ` — @${t.assignee}` : ''}`,
      );
    }
  }
  lines.push('');

  const activeSessions = snapshot.sessions.filter((s) => s.status !== 'archived');
  if (activeSessions.length > 0) {
    lines.push('## Linked Agent Sessions');
    for (const s of activeSessions) {
      const lag = snapshot.config.revision - s.lastSyncedRevision;
      const syncLabel = lag > 0 ? `behind by ${lag}` : 'synced';
      const parentLabel = s.parentSessionId ? ` (child of ${s.parentSessionId})` : '';
      lines.push(
        `- **${s.id}** [${s.harness}] ${s.title}${parentLabel} — _${s.status}, ${syncLabel}_${s.summary ? `: ${s.summary}` : ''}`,
      );
    }
    lines.push('');
  }

  if (snapshot.drift.staleArtifacts.length > 0) {
    lines.push('## Stale Artifacts Needing Refresh');
    for (const stale of snapshot.drift.staleArtifacts) {
      lines.push(`- [${stale.artifactType}] **${stale.title}** (\`${stale.artifactId}\`): ${stale.reasons.join('; ')}`);
    }
    lines.push('');
  }

  const recentEvents = snapshot.events.slice(-maxRecentEvents);
  if (recentEvents.length > 0) {
    lines.push('## Recent Changes');
    for (const ev of recentEvents) {
      lines.push(`- \`rev ${ev.revision}\` (${ev.kind}): ${ev.summary}`);
    }
    lines.push('');
  }

  if (includeUpdateProtocol) {
    lines.push('---');
    lines.push('## How to Sync Back Updates (Web / Non-MCP Chats)');
    lines.push(
      'When we reach new decisions, finish tasks, or update diagrams in this chat, output a fenced `json` block matching this schema so I can paste it straight into ContextDeck:',
    );
    lines.push('```json');
    lines.push(
      JSON.stringify(
        {
          sessionTitle: 'Short name for this chat',
          harness: 'grok',
          sessionSummary: 'What we concluded in this session',
          decisions: [
            {
              title: 'Decision title',
              summary: 'One-line decision summary',
              rationale: 'Why we made this choice',
              supersedes: null,
            },
          ],
          tasks: [
            {
              title: 'Follow-up task',
              column: 'backlog',
              priority: 'medium',
            },
          ],
        },
        null,
        2,
      ),
    );
    lines.push('```');
  }

  return lines.join('\n');
}

export function parseContextUpdatePayload(rawText: string): ContextUpdatePayload {
  const trimmed = rawText.trim();
  let candidate = trimmed;

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  } else {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidate = trimmed.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(
      `Could not parse JSON update payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return ContextUpdatePayloadSchema.parse(parsed);
}
