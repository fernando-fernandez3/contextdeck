import { ValidationError } from './errors.js';
import {
  ContextUpdatePayloadSchema,
  type BoardSnapshot,
  type ContextUpdatePayload,
} from './schemas.js';
import {
  UNTRUSTED_BOARD_CONTENT_FOOTER,
  UNTRUSTED_BOARD_CONTENT_HEADER,
  capSingleLine,
  isMeaningfulEvent,
  neutralizeUntrustedDelimiters,
} from './drift.js';

export interface ContextPackOptions {
  includeUpdateProtocol?: boolean;
  maxRecentEvents?: number;
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 12_000;
const MAX_TITLE_CHARS = 160;
const MAX_SUMMARY_CHARS = 300;

function appendSectionWithinBudget(
  sections: string[],
  rawCandidate: string,
  remainingChars: number,
  allowPartialTruncate = false,
): number {
  const candidate = neutralizeUntrustedDelimiters(rawCandidate);
  if (!candidate || remainingChars <= 0) return remainingChars;
  const separator = sections.length > 0 ? '\n\n' : '';
  const needed = separator.length + candidate.length;

  if (needed <= remainingChars) {
    sections.push(candidate);
    return remainingChars - needed;
  }

  if (allowPartialTruncate && remainingChars > separator.length + 40) {
    const notice = '\n… [truncated]';
    const sliceLen = Math.max(0, remainingChars - separator.length - notice.length);
    if (sliceLen > 20) {
      sections.push(`${candidate.slice(0, sliceLen).trimEnd()}${notice}`);
      return 0;
    }
  }

  return remainingChars;
}

function buildUpdateProtocolBlock(revision: number): string {
  const lines: string[] = [
    '---',
    '## How to Sync Back Updates (Web / Non-MCP Chats)',
    'When we reach new decisions, finish tasks, or update diagrams in this chat, output a fenced `json` block matching this schema so I can paste it straight into ContextDeck (include `"baseRevision"` if updating `"brief"`):',
    '```json',
    JSON.stringify(
      {
        baseRevision: revision,
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
    '```',
  ];
  return lines.join('\n');
}

/**
 * Generate a bounded Context Pack with priority truncation (D4) and fixed
 * untrusted-content delimiters (E3 amended):
 * Priority order: active decisions -> queued jobs -> open tasks -> brief excerpt -> active sessions -> stale/recent.
 */
export function generateContextPack(
  snapshot: BoardSnapshot,
  options: ContextPackOptions = {},
): string {
  const {
    includeUpdateProtocol = true,
    maxRecentEvents = 8,
    maxChars = DEFAULT_MAX_CHARS,
  } = options;

  const safeTitle = neutralizeUntrustedDelimiters(
    capSingleLine(String(snapshot.config.title), MAX_TITLE_CHARS),
  );
  const safeSlug = neutralizeUntrustedDelimiters(capSingleLine(String(snapshot.config.slug), 100));
  const safeUpdatedAt = neutralizeUntrustedDelimiters(
    capSingleLine(String(snapshot.config.updatedAt), 64),
  );
  const headerLines = [
    `# ContextDeck Shared Context: ${safeTitle}`,
    `> Board: \`${safeSlug}\` | Revision: \`rev ${snapshot.config.revision}\` | Updated: ${safeUpdatedAt}`,
  ];
  const header = neutralizeUntrustedDelimiters(headerLines.join('\n'));
  const protocolBlock = includeUpdateProtocol
    ? `\n\n${buildUpdateProtocolBlock(snapshot.config.revision)}`
    : '';

  const wrapperOverhead =
    header.length +
    2 + // \n\n before untrusted header
    UNTRUSTED_BOARD_CONTENT_HEADER.length +
    2 + // \n\n
    2 + // \n\n before footer
    UNTRUSTED_BOARD_CONTENT_FOOTER.length +
    protocolBlock.length;

  let remaining = Math.max(0, maxChars - wrapperOverhead);
  const bodySections: string[] = [];

  // Priority 1: Active Decisions (accepted, proposed, recently superseded)
  const acceptedDecisions = snapshot.decisions.filter((d) => d.status === 'accepted');
  const proposedDecisions = snapshot.decisions.filter((d) => d.status === 'proposed');
  const supersededDecisions = snapshot.decisions.filter((d) => d.status === 'superseded');
  {
    const lines: string[] = ['## Active Decisions'];
    if (acceptedDecisions.length === 0) {
      lines.push('_No accepted decisions yet._');
    } else {
      for (const d of acceptedDecisions) {
        const title = capSingleLine(d.title, MAX_TITLE_CHARS);
        const summary = d.summary ? `: ${capSingleLine(d.summary, MAX_SUMMARY_CHARS)}` : '';
        lines.push(`- **${d.id} — ${title}**${summary}`);
      }
    }
    if (proposedDecisions.length > 0) {
      lines.push('', '### Proposed Decisions');
      for (const d of proposedDecisions) {
        const title = capSingleLine(d.title, MAX_TITLE_CHARS);
        const summary = d.summary ? `: ${capSingleLine(d.summary, MAX_SUMMARY_CHARS)}` : '';
        lines.push(`- **${d.id} — ${title}**${summary}`);
      }
    }
    if (supersededDecisions.length > 0) {
      lines.push('', '### Recently Superseded (Do Not Use)');
      for (const d of supersededDecisions.slice(-5)) {
        const title = capSingleLine(d.title, MAX_TITLE_CHARS);
        lines.push(
          `- ~~${d.id} — ${title}~~${d.supersededBy ? ` (replaced by **${d.supersededBy}**)` : ''}`,
        );
      }
    }
    remaining = appendSectionWithinBudget(bodySections, lines.join('\n'), remaining, true);
  }

  // Priority 2: Queued Jobs (forward-compatible hook for B3 if present on snapshot)
  const queuedJobs = (snapshot as BoardSnapshot & {
    jobs?: Array<{ id: string; status: string; artifactType: string; artifactId: string; reason?: string }>;
  }).jobs?.filter((j) => j.status === 'queued');
  if (queuedJobs && queuedJobs.length > 0) {
    const lines = ['## Queued Refresh Jobs'];
    for (const job of queuedJobs) {
      lines.push(
        `- **${job.id}** [${job.artifactType}] \`${job.artifactId}\`${job.reason ? `: ${capSingleLine(job.reason, MAX_SUMMARY_CHARS)}` : ''}`,
      );
    }
    remaining = appendSectionWithinBudget(bodySections, lines.join('\n'), remaining, true);
  }

  // Priority 3: Open Tasks
  {
    const openTasks = snapshot.tasks.filter((t) => t.column !== 'done');
    const lines = ['## Open Tasks'];
    if (openTasks.length === 0) {
      lines.push('_No open tasks._');
    } else {
      for (const t of openTasks) {
        const title = capSingleLine(t.title, MAX_TITLE_CHARS);
        const assignee = t.assignee !== 'unassigned' ? ` — @${capSingleLine(t.assignee, 60)}` : '';
        lines.push(`- [${t.column}] **${t.id}** (${t.priority}) ${title}${assignee}`);
      }
    }
    remaining = appendSectionWithinBudget(bodySections, lines.join('\n'), remaining, true);
  }

  // Priority 4: Living Brief Excerpt
  if (snapshot.brief.trim()) {
    const briefBlock = `## Living Brief (Current Mental Model)\n${snapshot.brief.trim()}`;
    remaining = appendSectionWithinBudget(bodySections, briefBlock, remaining, true);
  }

  // Priority 5: Active Sessions (using honest drift counts)
  const activeSessions = snapshot.sessions.filter(
    (s) => s.status !== 'archived' && s.status !== 'completed',
  );
  if (activeSessions.length > 0) {
    const driftBySession = new Map(
      snapshot.drift.driftedSessions.map((d) => [d.sessionId, d.behindBy]),
    );
    const lines = ['## Linked Agent Sessions'];
    for (const s of activeSessions) {
      const lag = driftBySession.get(s.id) ?? 0;
      const syncLabel = lag > 0 ? `behind by ${lag}` : 'synced';
      const parentLabel = s.parentSessionId ? ` (child of ${s.parentSessionId})` : '';
      const title = capSingleLine(s.title, MAX_TITLE_CHARS);
      const summary = s.summary ? `: ${capSingleLine(s.summary, MAX_SUMMARY_CHARS)}` : '';
      lines.push(
        `- **${s.id}** [${capSingleLine(s.harness, 40)}] ${title}${parentLabel} — _${s.status}, ${syncLabel}_${summary}`,
      );
    }
    remaining = appendSectionWithinBudget(bodySections, lines.join('\n'), remaining, true);
  }

  // Priority 6: Stale Artifacts & Recent Meaningful Changes
  if (snapshot.drift.staleArtifacts.length > 0) {
    const lines = ['## Stale Artifacts Needing Refresh'];
    for (const stale of snapshot.drift.staleArtifacts) {
      lines.push(
        `- [${stale.artifactType}] **${capSingleLine(stale.title, MAX_TITLE_CHARS)}** (\`${stale.artifactId}\`): ${capSingleLine(stale.reasons.join('; '), MAX_SUMMARY_CHARS)}`,
      );
    }
    remaining = appendSectionWithinBudget(bodySections, lines.join('\n'), remaining, true);
  }

  const recentEvents = snapshot.events
    .filter((ev) => isMeaningfulEvent(ev.kind))
    .slice(-maxRecentEvents);
  if (recentEvents.length > 0) {
    const lines = ['## Recent Changes'];
    for (const ev of recentEvents) {
      lines.push(
        `- \`rev ${ev.revision}\` (${ev.kind}): ${capSingleLine(ev.summary, MAX_SUMMARY_CHARS)}`,
      );
    }
    remaining = appendSectionWithinBudget(bodySections, lines.join('\n'), remaining, true);
  }

  const innerBody = neutralizeUntrustedDelimiters(bodySections.join('\n\n'));
  const full = `${header}\n\n${UNTRUSTED_BOARD_CONTENT_HEADER}\n\n${innerBody}\n\n${UNTRUSTED_BOARD_CONTENT_FOOTER}${protocolBlock}`;
  if (full.length <= maxChars) {
    return full;
  }
  return full.slice(0, maxChars);
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

  const validated = ContextUpdatePayloadSchema.safeParse(parsed);
  if (!validated.success) {
    const msg = validated.error.issues
      .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid context update payload: ${msg}`);
  }
  return validated.data;
}
