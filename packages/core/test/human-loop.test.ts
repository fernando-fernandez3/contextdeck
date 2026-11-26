import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-b3-core-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('B3 Core: Reader cursors & Catch up (AC7.1, AC7.2, D16)', () => {
  it('stores reader cursors per reader & board under .runtime/readers without appending events to events.jsonl', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Alpha', slug: 'alpha', setAsDefault: true });
    await store.createBoard({ title: 'Beta', slug: 'beta' });

    const d1 = await store.recordDecision('alpha', { title: 'Use Redis' });
    const d2 = await store.recordDecision('alpha', {
      title: 'Use Plain Files',
      supersedes: d1.id,
      summary: 'Zero-daemon local-first storage.',
    });
    const t1 = await store.upsertTask('alpha', { title: 'Migrate storage', column: 'backlog' });
    await store.patchTask('alpha', t1.id, { column: 'in_progress' });
    await store.upsertDiagram('alpha', {
      title: 'Storage Flow',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });
    await store.registerSession('alpha', { title: 'Backend Session', harness: 'codex' });

    const snap = await store.getSnapshot('alpha');
    const beforeEventCount = snap.events.length;
    const beforeRev = snap.config.revision;

    // First look (no cursor yet) -> has unseen changes
    const cursorBefore = await store.getReaderCursor('alpha', 'reader_alice');
    expect(cursorBefore).toBeNull();

    const catchUp1 = core.computeCatchUp(snap, cursorBefore);
    expect(catchUp1.fromRevision).toBe(0);
    expect(catchUp1.toRevision).toBe(beforeRev);
    expect(catchUp1.hasUnseen).toBe(true);
    expect(catchUp1.unseenCount).toBeGreaterThan(0);
    expect(catchUp1.decisionsChanged.some((d) => d.decisionId === d2.id && d.previousDecisionId === d1.id)).toBe(true);
    expect(catchUp1.staleArtifacts.some((a) => a.title === 'Storage Flow')).toBe(true);
    expect(catchUp1.tasksMoved.some((t) => t.taskId === t1.id && t.toColumn === 'in_progress')).toBe(true);
    expect(catchUp1.newSessions.some((s) => s.title === 'Backend Session')).toBe(true);

    // Acknowledge displayed revision for reader_alice on alpha ONLY
    const acked = await store.ackReaderCursor('alpha', beforeRev, { readerId: 'reader_alice' });
    expect(acked.lastReviewedRevision).toBe(beforeRev);

    // D16: No reader.* events in events.jsonl, board revision unchanged
    const snapAfterAck = await store.getSnapshot('alpha');
    expect(snapAfterAck.config.revision).toBe(beforeRev);
    expect(snapAfterAck.events).toHaveLength(beforeEventCount);
    expect(snapAfterAck.events.some((e) => e.kind.startsWith('reader.'))).toBe(false);

    // Cursor file lives under .runtime/readers/<readerId>.yaml
    const readerFile = path.join(store.runtimeDir, 'readers', 'reader_alice.yaml');
    await expect(fs.stat(readerFile)).resolves.toBeTruthy();

    // reader_alice is now caught up on alpha; reader_bob is still unseen; reader_alice on beta is untouched
    const catchUpAlice = core.computeCatchUp(snapAfterAck, await store.getReaderCursor('alpha', 'reader_alice'));
    expect(catchUpAlice.hasUnseen).toBe(false);
    expect(catchUpAlice.unseenCount).toBe(0);
    expect(catchUpAlice.decisionsChanged).toEqual([]);
    expect(catchUpAlice.staleArtifacts).toEqual([]);
    expect(catchUpAlice.tasksMoved).toEqual([]);
    expect(catchUpAlice.newSessions).toEqual([]);

    expect(await store.getReaderCursor('alpha', 'reader_bob')).toBeNull();
    expect(await store.getReaderCursor('beta', 'reader_alice')).toBeNull();

    // Ack cannot rewind cursor backwards
    const noRewind = await store.ackReaderCursor('alpha', 1, { readerId: 'reader_alice' });
    expect(noRewind.lastReviewedRevision).toBe(beforeRev);

    // A new change makes reader_alice see only the delta
    const d3 = await store.recordDecision('alpha', {
      title: 'Add WAL checksums',
      supersedes: d2.id,
      summary: 'Detect torn writes.',
    });
    const snapAfterD3 = await store.getSnapshot('alpha');
    const catchUpDelta = core.computeCatchUp(
      snapAfterD3,
      await store.getReaderCursor('alpha', 'reader_alice'),
    );
    expect(catchUpDelta.fromRevision).toBe(beforeRev);
    expect(catchUpDelta.toRevision).toBe(snapAfterD3.config.revision);
    expect(catchUpDelta.unseenCount).toBe(1);
    expect(catchUpDelta.decisionsChanged).toHaveLength(1);
    expect(catchUpDelta.decisionsChanged[0].decisionId).toBe(d3.id);
    expect(catchUpDelta.decisionsChanged[0].previousDecisionId).toBe(d2.id);
  });
});

describe('B3 Core: Confirm vs Refresh & removal of Mark Aligned (AC7.3, D17)', () => {
  it('removes refreshArtifactDecisions and implements confirmations map with auto re-stale on next supersede', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Confirmations', slug: 'main' });

    // D17: old refreshArtifactDecisions must be removed
    expect((store as unknown as Record<string, unknown>).refreshArtifactDecisions).toBeUndefined();

    const d1 = await store.recordDecision('main', { title: 'Auth via Cookies' });
    const diag = await store.upsertDiagram('main', {
      title: 'Auth Diagram',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });
    const task = await store.upsertTask('main', {
      title: 'Implement Auth',
      linkedDecisionIds: [d1.id],
    });
    const d2 = await store.recordDecision('main', {
      title: 'Auth via JWT',
      supersedes: d1.id,
    });

    // Diagram is stale against d1 -> d2
    const snapStale = await store.getSnapshot('main');
    expect(snapStale.drift.staleArtifacts.some((s) => s.artifactId === diag.id)).toBe(true);

    // D17: tasks are not confirm/refresh targets
    await expect(
      store.confirmArtifact('main', 'task' as never, task.id, { note: 'nope' }, { type: 'human', label: 'alice' }),
    ).rejects.toThrow(/task|artifact/i);

    // Human confirms diagram against d2 without rewriting basedOnDecisions
    const confirmed = await store.confirmArtifact(
      'main',
      'diagram',
      diag.id,
      { note: 'High-level box flow still accurate' },
      { type: 'human', label: 'alice' },
    );
    expect(confirmed.basedOnDecisions).toEqual([d1.id]);
    expect(confirmed.confirmations[d1.id]).toMatchObject({
      againstDecisionId: d2.id,
      confirmedBy: 'alice',
      actorType: 'human',
      note: 'High-level box flow still accurate',
    });

    // Drift clears for diag while latest replacement is d2
    const snapConfirmed = await store.getSnapshot('main');
    expect(snapConfirmed.drift.staleArtifacts.some((s) => s.artifactId === diag.id)).toBe(false);

    // Auto re-stale when d2 is superseded by d3!
    const d3 = await store.recordDecision('main', {
      title: 'Auth via Passkeys',
      supersedes: d2.id,
    });
    const snapReStale = await store.getSnapshot('main');
    const reStale = snapReStale.drift.staleArtifacts.find((s) => s.artifactId === diag.id);
    expect(reStale).toBeDefined();
    expect(reStale!.staleDecisionIds).toContain(d1.id);
    expect(reStale!.reasons[0]).toContain(d3.id);

    // Agent confirmation records actorType === 'agent'
    const agentConfirmed = await store.confirmArtifact(
      'main',
      'diagram',
      diag.id,
      { note: 'Verified abstract boundary holds' },
      { type: 'agent', harness: 'codex', sessionId: 'sess_1' },
    );
    expect(agentConfirmed.confirmations[d1.id].actorType).toBe('agent');
    expect(agentConfirmed.confirmations[d1.id].againstDecisionId).toBe(d3.id);
  });
});

describe('B3 Core: Refresh Jobs, Leases, Dedupe, Completion Gate, and Neon 15 Digest (AC7.4, D19)', () => {
  it('supports create (with dedupe), atomic claim + lease TTL + renew + release + strict completion verification', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Jobs', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Old Spec' });
    const diag = await store.upsertDiagram('main', {
      title: 'Architecture',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->Old',
      basedOnDecisions: [d1.id],
    });
    const d2 = await store.recordDecision('main', { title: 'New Spec', supersedes: d1.id });

    // Create refresh job -> deduped on second call
    const r1 = await store.createRefreshJob(
      'main',
      { artifactType: 'diagram', artifactId: diag.id, reason: 'Update for New Spec' },
      { type: 'human', label: 'alice' },
    );
    expect(r1.deduplicated).toBe(false);
    expect(r1.job.status).toBe('queued');
    expect(r1.job.baseVersion).toBe(1);
    expect(r1.job.decisionsBefore).toEqual([d1.id]);
    expect(r1.job.decisionsNow).toEqual([d2.id]);

    const r2 = await store.createRefreshJob(
      'main',
      { artifactType: 'diagram', artifactId: diag.id },
      { type: 'human', label: 'alice' },
    );
    expect(r2.deduplicated).toBe(true);
    expect(r2.job.id).toBe(r1.job.id);
    expect(await store.listJobs('main')).toHaveLength(1);

    // Queued job appears in Context Pack
    const snapQueued = await store.getSnapshot('main');
    const pack = core.generateContextPack(snapQueued, { includeUpdateProtocol: false });
    expect(pack).toContain('## Queued Refresh Jobs');
    expect(pack).toContain(r1.job.id);

    // Atomic claim grants lease token with 15 min default TTL
    const t0 = new Date('2026-11-26T12:00:00.000Z');
    const claimed = await store.claimJob(
      'main',
      { jobId: r1.job.id, claimedBy: 'worker-1', now: t0 },
      { type: 'agent', label: 'worker-1' },
    );
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('claimed');
    expect(claimed!.leaseToken).toBeTruthy();
    expect(Date.parse(claimed!.leaseExpiresAt!) - t0.getTime()).toBe(15 * 60 * 1000);

    // Second claim while lease is active must fail / return conflict
    await expect(
      store.claimJob(
        'main',
        { jobId: r1.job.id, claimedBy: 'worker-2', now: new Date(t0.getTime() + 60_000) },
        { type: 'agent', label: 'worker-2' },
      ),
    ).rejects.toThrow(/claimed|lease/i);

    // Renew with wrong lease token rejected; right token extends TTL
    await expect(
      store.renewJob('main', r1.job.id, { leaseToken: 'wrong', now: new Date(t0.getTime() + 60_000) }),
    ).rejects.toThrow(/lease/i);
    const renewed = await store.renewJob('main', r1.job.id, {
      leaseToken: claimed!.leaseToken!,
      now: new Date(t0.getTime() + 5 * 60 * 1000),
    });
    expect(Date.parse(renewed.leaseExpiresAt!)).toBeGreaterThan(Date.parse(claimed!.leaseExpiresAt!));

    // Release returns job to queued
    const released = await store.releaseJob('main', r1.job.id, { leaseToken: claimed!.leaseToken! });
    expect(released.status).toBe('queued');
    expect(released.leaseToken).toBeNull();

    // Reclaim, then expire lease after 16 min -> another worker can reclaim
    const c2 = await store.claimJob('main', { jobId: r1.job.id, claimedBy: 'worker-1', now: t0 });
    const c3 = await store.claimJob('main', {
      jobId: r1.job.id,
      claimedBy: 'worker-2',
      now: new Date(t0.getTime() + 16 * 60 * 1000),
    });
    expect(c3!.claimedBy).toBe('worker-2');
    expect(c3!.leaseToken).not.toBe(c2!.leaseToken);

    // D19: Completing without a new artifact version created by this job MUST be rejected!
    await expect(
      store.completeJob('main', r1.job.id, {
        leaseToken: c3!.leaseToken!,
        now: new Date(t0.getTime() + 17 * 60 * 1000),
      }),
    ).rejects.toThrow(/version|createdByJob/i);

    // Updating diagram WITHOUT linking jobId also fails D19 completion check
    await store.upsertDiagram('main', {
      id: diag.id,
      title: diag.title,
      kind: 'mermaid',
      content: 'flowchart LR\nA-->UnrelatedEdit',
      basedOnDecisions: [d2.id],
    });
    await expect(
      store.completeJob('main', r1.job.id, {
        leaseToken: c3!.leaseToken!,
        now: new Date(t0.getTime() + 17 * 60 * 1000),
      }),
    ).rejects.toThrow(/createdByJob|job/i);

    // Updating diagram WITH jobId + leaseToken and new content satisfies D19 and allows completion
    const updatedDiag = await store.upsertDiagram('main', {
      id: diag.id,
      title: diag.title,
      kind: 'mermaid',
      content: 'flowchart LR\nA-->NewSpec',
      basedOnDecisions: [d2.id],
      jobId: r1.job.id,
      leaseToken: c3!.leaseToken!,
      now: new Date(t0.getTime() + 17 * 60 * 1000),
    });
    expect(updatedDiag.version).toBe(3);

    const completed = await store.completeJob('main', r1.job.id, {
      leaseToken: c3!.leaseToken!,
      artifactVersion: updatedDiag.version,
      summary: 'Regenerated diagram for New Spec',
      now: new Date(t0.getTime() + 17 * 60 * 1000),
    });
    expect(completed.status).toBe('done');
    expect(completed.result?.artifactVersion).toBe(3);
  });

  it('Neon 15 rule: queued job appears in hook digest ONLY when job.created is in the missed window', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Digest Jobs', slug: 'main' });

    const s1 = await store.registerSession('main', { title: 'S1', harness: 'claude-code' });
    const d1 = await store.recordDecision('main', { title: 'Old' });
    const media = await store.addMedia('main', {
      title: 'OAuth Explainer',
      kind: 'video',
      basedOnDecisions: [d1.id],
    });
    await store.recordDecision('main', { title: 'New OAuth', supersedes: d1.id });
    // Sync s1 BEFORE job creation
    await store.syncSession('main', s1.id);

    // Create refresh job -> s1 missed job.created -> digest includes it!
    const { job } = await store.createRefreshJob(
      'main',
      { artifactType: 'media', artifactId: media.id },
      { type: 'human', label: 'alice' },
    );
    const drift1 = await store.getSessionDrift('main', s1.id);
    expect(drift1.behindBy).toBe(1);
    expect(drift1.digestText).toContain('OAuth Explainer');
    expect(drift1.digest.some((e) => e.kind === 'job.created' && e.entityId === job.id)).toBe(true);

    // Sync s1 AFTER job creation -> job is still queued, but NO new events -> digest must be empty!
    await store.syncSession('main', s1.id);
    const drift2 = await store.getSessionDrift('main', s1.id);
    expect(drift2.behindBy).toBe(0);
    expect(drift2.digestText).toBe('');

    // Unrelated task created -> digest mentions ONLY the task, NOT the previously seen queued job!
    await store.upsertTask('main', { title: 'Unrelated task' }, { type: 'human', label: 'alice' });
    const drift3 = await store.getSessionDrift('main', s1.id);
    expect(drift3.behindBy).toBe(1);
    expect(drift3.digestText).toContain('Unrelated task');
    expect(drift3.digestText).not.toContain('OAuth Explainer');
  });
});

describe('B3 Core: Immutable Media Versions, Quiz Update, Prune, and Per-Question Staleness (AC7.6, AC7.7, D17, D19)', () => {
  it('stores immutable <id>.v<N>.<ext> media files, protects open-job versions during prune, and removes all versions on delete', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Versioning', slug: 'main' });

    const srcV1 = path.join(dir, 'v1.mp4');
    const srcV2 = path.join(dir, 'v2.mp4');
    const srcV3 = path.join(dir, 'v3.mp4');
    await fs.writeFile(srcV1, Buffer.from('video-bytes-v1'));
    await fs.writeFile(srcV2, Buffer.from('video-bytes-v2'));
    await fs.writeFile(srcV3, Buffer.from('video-bytes-v3'));

    const d1 = await store.recordDecision('main', { title: 'D1' });
    const art = await store.addMedia('main', {
      title: 'Explainer',
      kind: 'video',
      sourceFilePath: srcV1,
      basedOnDecisions: [d1.id],
    });
    expect(art.version).toBe(1);
    expect(art.filePath).toBe(`${art.id}.v1.mp4`);

    const mediaDir = path.join(store.boardPath('main'), 'media');
    expect(await fs.readFile(path.join(mediaDir, `${art.id}.v1.mp4`), 'utf8')).toBe('video-bytes-v1');

    // Update to v2 -> v1 stays on disk!
    const v2 = await store.updateMedia('main', art.id, {
      sourceFilePath: srcV2,
      transcript: 'v2 narration',
    });
    expect(v2.version).toBe(2);
    expect(v2.filePath).toBe(`${art.id}.v2.mp4`);
    expect(v2.history).toHaveLength(2);
    expect(await fs.readFile(path.join(mediaDir, `${art.id}.v1.mp4`), 'utf8')).toBe('video-bytes-v1');
    expect(await fs.readFile(path.join(mediaDir, `${art.id}.v2.mp4`), 'utf8')).toBe('video-bytes-v2');

    // Open job created at baseVersion 2 -> claim first (D19), write v3 under active lease,
    // and verify v2 is protected from prune while job is still open!
    const d2 = await store.recordDecision('main', { title: 'D2', supersedes: d1.id });
    const { job } = await store.createRefreshJob('main', {
      artifactType: 'media',
      artifactId: art.id,
    });
    expect(job.baseVersion).toBe(2);

    const claimed = await store.claimJob('main', { jobId: job.id, claimedBy: 'worker' });
    const v3 = await store.updateMedia('main', art.id, {
      sourceFilePath: srcV3,
      basedOnDecisions: [d2.id],
      jobId: job.id,
      leaseToken: claimed!.leaseToken!,
    });
    expect(v3.version).toBe(3);
    expect(v3.filePath).toBe(`${art.id}.v3.mp4`);

    // Prune while job is STILL OPEN (claimed) -> v1 pruned, v2 (baseVersion of open job) & v3 (current) KEPT!
    const prune1 = await store.pruneMedia('main', { keepVersions: 1 });
    expect(prune1.prunedFiles).toContain(`${art.id}.v1.mp4`);
    expect(prune1.prunedFiles).not.toContain(`${art.id}.v2.mp4`);
    expect(prune1.prunedFiles).not.toContain(`${art.id}.v3.mp4`);
    await expect(fs.stat(path.join(mediaDir, `${art.id}.v1.mp4`))).rejects.toThrow();
    await expect(fs.stat(path.join(mediaDir, `${art.id}.v2.mp4`))).resolves.toBeTruthy();

    // Complete job -> now prune removes v2 too
    await store.completeJob('main', job.id, { leaseToken: claimed!.leaseToken!, artifactVersion: 3 });

    const prune2 = await store.pruneMedia('main', { keepVersions: 1 });
    expect(prune2.prunedFiles).toContain(`${art.id}.v2.mp4`);
    await expect(fs.stat(path.join(mediaDir, `${art.id}.v2.mp4`))).rejects.toThrow();
    await expect(fs.stat(path.join(mediaDir, `${art.id}.v3.mp4`))).resolves.toBeTruthy();

    // Add v4 then deleteMedia -> removes ALL versioned files (v3 and v4) + meta
    await store.updateMedia('main', art.id, { sourceFilePath: srcV1 });
    await store.deleteMedia('main', art.id);
    const remaining = await fs.readdir(mediaDir);
    expect(remaining.filter((f) => f.startsWith(art.id))).toEqual([]);
  });

  it('quiz_update preserves attempts, bumps version (history capped at 10), and flags per-question staleness via relatedDecisionIds', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Quizzes', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Use REST' });
    const d2 = await store.recordDecision('main', { title: 'Use Strict TS' });
    const quiz = await store.createQuiz('main', {
      title: 'Core Mastery',
      basedOnDecisions: [d1.id, d2.id],
      questions: [
        {
          id: 'q1',
          prompt: 'Which API style?',
          type: 'multiple_choice',
          options: ['REST', 'SOAP'],
          correctIndex: 0,
          explanation: 'REST per d1',
          relatedDecisionIds: [d1.id],
        },
        {
          id: 'q2',
          prompt: 'Strict TypeScript?',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: 'Strict per d2',
          relatedDecisionIds: [d2.id],
        },
      ],
    });

    await store.submitQuizAttempt('main', quiz.id, { answers: { q1: 0, q2: 'true' }, confidence: 4 });
    const d3 = await store.recordDecision('main', { title: 'Use gRPC', supersedes: d1.id });

    // AC7.7: Only q1 is flagged stale; q2 stays fresh!
    const snap = await store.getSnapshot('main');
    const qStale = core.evaluateQuizQuestionStaleness(snap.quizzes[0], snap.decisions);
    expect(qStale.q1?.staleDecisionIds).toEqual([d1.id]);
    expect(qStale.q1?.reasons[0]).toContain(d3.id);
    expect(qStale.q2).toBeUndefined();

    // D17: updateQuiz bumps version and preserves attempts!
    const updated = await store.updateQuiz('main', quiz.id, {
      basedOnDecisions: [d3.id, d2.id],
      questions: [
        {
          id: 'q1',
          prompt: 'Which RPC style?',
          type: 'multiple_choice',
          options: ['gRPC', 'SOAP'],
          correctIndex: 0,
          explanation: 'gRPC per d3',
          relatedDecisionIds: [d3.id],
        },
        snap.quizzes[0].questions[1],
      ],
    });
    expect(updated.version).toBe(2);
    expect(updated.attempts).toHaveLength(1);
    expect(updated.attempts[0].percentage).toBe(100);
    expect(updated.history).toHaveLength(2);

    // History capped at 10 entries across 12 updates
    for (let i = 0; i < 12; i += 1) {
      await store.updateQuiz('main', quiz.id, {
        questions: [
          {
            id: 'q1',
            prompt: `Question rev ${i}`,
            type: 'true_false',
            correctAnswer: 'true',
            explanation: 'ok',
            relatedDecisionIds: [d3.id],
          },
        ],
      });
    }
    const finalSnap = await store.getSnapshot('main');
    expect(finalSnap.quizzes[0].version).toBe(14);
    expect(finalSnap.quizzes[0].history).toHaveLength(10);
    expect(finalSnap.quizzes[0].attempts).toHaveLength(1);
  });
});

describe('B3 Hardening G1: Claim-bound refresh jobs, substantive changes, and prune input protection (H1-H3)', () => {
  it('H1: binds jobId writes to an active leaseToken/claim and rejects queued, wrong, expired, or cross-claim completions', async () => {
    const dir = await makeTempDir('cdeck-h1-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H1', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Spec v1' });
    const diag = await store.upsertDiagram('main', {
      title: 'System Flow',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->V1',
      basedOnDecisions: [d1.id],
    });
    const d2 = await store.recordDecision('main', { title: 'Spec v2', supersedes: d1.id });
    const { job } = await store.createRefreshJob('main', {
      artifactType: 'diagram',
      artifactId: diag.id,
    });

    // (a) jobId write on a queued job MUST be rejected (even without or with fake leaseToken)
    await expect(
      store.upsertDiagram('main', {
        id: diag.id,
        title: diag.title,
        kind: 'mermaid',
        content: 'flowchart LR\nA-->PreClaim',
        basedOnDecisions: [d2.id],
        jobId: job.id,
      }),
    ).rejects.toThrow(/lease|claim/i);

    const t0 = new Date('2026-11-26T12:00:00.000Z');
    const claimA = await store.claimJob('main', { jobId: job.id, claimedBy: 'worker-A', now: t0 });
    expect(claimA?.leaseToken).toBeTruthy();

    // (b) Wrong leaseToken rejected
    await expect(
      store.upsertDiagram('main', {
        id: diag.id,
        title: diag.title,
        kind: 'mermaid',
        content: 'flowchart LR\nA-->WrongToken',
        basedOnDecisions: [d2.id],
        jobId: job.id,
        leaseToken: 'wrong-lease-token',
        now: new Date(t0.getTime() + 60_000),
      }),
    ).rejects.toThrow(/lease/i);

    // (b2) Expired leaseToken rejected
    await expect(
      store.upsertDiagram('main', {
        id: diag.id,
        title: diag.title,
        kind: 'mermaid',
        content: 'flowchart LR\nA-->ExpiredToken',
        basedOnDecisions: [d2.id],
        jobId: job.id,
        leaseToken: claimA!.leaseToken!,
        now: new Date(t0.getTime() + 16 * 60 * 1000),
      }),
    ).rejects.toThrow(/expired|lease/i);

    // (c) Worker A writes v2 while lease is valid, then lease expires and Worker B reclaims
    const v2ByA = await store.upsertDiagram('main', {
      id: diag.id,
      title: diag.title,
      kind: 'mermaid',
      content: 'flowchart LR\nA-->WorkerA',
      basedOnDecisions: [d2.id],
      jobId: job.id,
      leaseToken: claimA!.leaseToken!,
      now: new Date(t0.getTime() + 60_000),
    });
    expect(v2ByA.version).toBe(2);
    const v2Entry = v2ByA.history.find((h) => h.version === 2)!;
    expect(v2Entry.createdByJob).toBe(job.id);
    expect(v2Entry.createdByClaim).toMatch(/^[0-9a-f]{16}$/);
    expect(v2Entry.createdByClaim).not.toBe(claimA!.leaseToken);

    const claimB = await store.claimJob('main', {
      jobId: job.id,
      claimedBy: 'worker-B',
      now: new Date(t0.getTime() + 16 * 60 * 1000),
    });
    expect(claimB?.leaseToken).toBeTruthy();
    expect(claimB?.leaseToken).not.toBe(claimA?.leaseToken);

    // Worker B CANNOT complete against Worker A's v2!
    await expect(
      store.completeJob('main', job.id, {
        leaseToken: claimB!.leaseToken!,
        artifactVersion: 2,
        now: new Date(t0.getTime() + 17 * 60 * 1000),
      }),
    ).rejects.toThrow(/claim/i);

    // (d) Happy path: Worker B writes v3 with B's leaseToken and completes
    const v3ByB = await store.upsertDiagram('main', {
      id: diag.id,
      title: diag.title,
      kind: 'mermaid',
      content: 'flowchart LR\nA-->WorkerB',
      basedOnDecisions: [d2.id],
      jobId: job.id,
      leaseToken: claimB!.leaseToken!,
      now: new Date(t0.getTime() + 17 * 60 * 1000),
    });
    expect(v3ByB.version).toBe(3);

    const done = await store.completeJob('main', job.id, {
      leaseToken: claimB!.leaseToken!,
      artifactVersion: 3,
      now: new Date(t0.getTime() + 17 * 60 * 1000),
    });
    expect(done.status).toBe('done');

    // Codex 1 repro: Worker A's late write after B completed MUST be rejected (with old token or without token)
    await expect(
      store.upsertDiagram('main', {
        id: diag.id,
        title: diag.title,
        kind: 'mermaid',
        content: 'flowchart LR\nOLD-->WRONG',
        basedOnDecisions: [d2.id],
        jobId: job.id,
        leaseToken: claimA!.leaseToken!,
        now: new Date(t0.getTime() + 18 * 60 * 1000),
      }),
    ).rejects.toThrow(/claim|lease/i);
    await expect(
      store.upsertDiagram('main', {
        id: diag.id,
        title: diag.title,
        kind: 'mermaid',
        content: 'flowchart LR\nOLD-->WRONG',
        basedOnDecisions: [d2.id],
        jobId: job.id,
      }),
    ).rejects.toThrow(/lease|claim/i);

    const snap = await store.getSnapshot('main');
    const latestDiag = snap.diagrams.find((d) => d.id === diag.id)!;
    expect(latestDiag.version).toBe(3);
    expect(latestDiag.content).toBe('flowchart LR\nA-->WorkerB');
  });

  it('H2: rejects transcript-only refresh updates on file-backed video/audio and rejects unchanged content on completeJob for media/diagram/quiz', async () => {
    const dir = await makeTempDir('cdeck-h2-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H2', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'D1' });
    const srcMp4 = path.join(dir, 'clip.mp4');
    const srcMp3 = path.join(dir, 'clip.mp3');
    await fs.writeFile(srcMp4, Buffer.from('video-v1'));
    await fs.writeFile(srcMp3, Buffer.from('audio-v1'));

    const video = await store.addMedia('main', {
      title: 'Video',
      kind: 'video',
      sourceFilePath: srcMp4,
      basedOnDecisions: [d1.id],
    });
    const audio = await store.addMedia('main', {
      title: 'Audio',
      kind: 'audio',
      sourceFilePath: srcMp3,
      basedOnDecisions: [d1.id],
    });
    const diag = await store.upsertDiagram('main', {
      title: 'Arch',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });
    const quiz = await store.createQuiz('main', {
      title: 'Quiz',
      basedOnDecisions: [d1.id],
      questions: [
        {
          id: 'q1',
          prompt: 'Q1?',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: 'yes',
          relatedDecisionIds: [d1.id],
        },
      ],
    });
    await store.recordDecision('main', { title: 'D2', supersedes: d1.id });

    // File-backed video: transcript-only update with jobId MUST be rejected
    const { job: vJob } = await store.createRefreshJob('main', { artifactType: 'media', artifactId: video.id });
    const vClaim = await store.claimJob('main', { jobId: vJob.id, claimedBy: 'w1' });
    await expect(
      store.updateMedia('main', video.id, {
        transcript: 'new transcript only',
        jobId: vJob.id,
        leaseToken: vClaim!.leaseToken!,
      }),
    ).rejects.toThrow(/media file|binary/i);

    // File-backed audio: transcript-only update with jobId MUST be rejected
    const { job: aJob } = await store.createRefreshJob('main', { artifactType: 'media', artifactId: audio.id });
    const aClaim = await store.claimJob('main', { jobId: aJob.id, claimedBy: 'w1' });
    await expect(
      store.updateMedia('main', audio.id, {
        transcript: 'new audio transcript only',
        jobId: aJob.id,
        leaseToken: aClaim!.leaseToken!,
      }),
    ).rejects.toThrow(/media file|binary/i);

    // Diagram: byte-identical update rejected, AND reverting to base content rejected on completeJob
    const { job: dJob } = await store.createRefreshJob('main', { artifactType: 'diagram', artifactId: diag.id });
    const dClaim = await store.claimJob('main', { jobId: dJob.id, claimedBy: 'w1' });
    await expect(
      store.upsertDiagram('main', {
        id: diag.id,
        title: diag.title,
        kind: 'mermaid',
        content: 'flowchart LR\nA-->B',
        jobId: dJob.id,
        leaseToken: dClaim!.leaseToken!,
      }),
    ).rejects.toThrow(/content/i);

    // Change diagram outside job to temp content, then write back base content under jobId -> completeJob rejects!
    await store.upsertDiagram('main', {
      id: diag.id,
      title: diag.title,
      kind: 'mermaid',
      content: 'flowchart LR\nA-->TEMP',
    });
    await store.upsertDiagram('main', {
      id: diag.id,
      title: diag.title,
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      jobId: dJob.id,
      leaseToken: dClaim!.leaseToken!,
    });
    await expect(
      store.completeJob('main', dJob.id, { leaseToken: dClaim!.leaseToken!, artifactVersion: 3 }),
    ).rejects.toThrow(/unchanged|identical|content/i);

    // Quiz: unchanged questions rejected, AND reverting to base questions rejected on completeJob
    const { job: qJob } = await store.createRefreshJob('main', { artifactType: 'quiz', artifactId: quiz.id });
    const qClaim = await store.claimJob('main', { jobId: qJob.id, claimedBy: 'w1' });
    await expect(
      store.updateQuiz('main', quiz.id, {
        questions: quiz.questions,
        jobId: qJob.id,
        leaseToken: qClaim!.leaseToken!,
      }),
    ).rejects.toThrow(/questions/i);

    await store.updateQuiz('main', quiz.id, {
      questions: [{ ...quiz.questions[0], prompt: 'Temp prompt?' }],
    });
    await store.updateQuiz('main', quiz.id, {
      questions: quiz.questions,
      jobId: qJob.id,
      leaseToken: qClaim!.leaseToken!,
    });
    await expect(
      store.completeJob('main', qJob.id, { leaseToken: qClaim!.leaseToken!, artifactVersion: 3 }),
    ).rejects.toThrow(/unchanged|questions/i);
  });

  it('H3: pruneMedia protects an open job input file even after capped history rolls over (Codex 2 repro)', async () => {
    const dir = await makeTempDir('cdeck-h3-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H3', slug: 'main' });

    const v1 = path.join(dir, 'v1.mp4');
    const v13 = path.join(dir, 'v13.mp4');
    await fs.writeFile(v1, Buffer.from('mp4-bytes-v1'));
    await fs.writeFile(v13, Buffer.from('mp4-bytes-v13'));

    const art = await store.addMedia('main', {
      id: 'art_test',
      title: 'Test Video',
      kind: 'video',
      sourceFilePath: v1,
    });
    expect(art.filePath).toBe('art_test.v1.mp4');

    // 11 title-only updates -> artifact v12 still referencing art_test.v1.mp4
    for (let i = 2; i <= 12; i += 1) {
      await store.updateMedia('main', art.id, { title: `Test Video v${i}` });
    }

    // Open a refresh job at baseVersion 12
    const { job } = await store.createRefreshJob('main', {
      artifactType: 'media',
      artifactId: art.id,
    });
    expect(job.baseVersion).toBe(12);

    // Replace binary at v13, then 10 title-only updates through v23 so history rolls over v1..v13
    const updated13 = await store.updateMedia('main', art.id, { sourceFilePath: v13 });
    expect(updated13.filePath).toBe('art_test.v13.mp4');
    for (let i = 14; i <= 23; i += 1) {
      await store.updateMedia('main', art.id, { title: `Test Video v${i}` });
    }

    // Dry-run prune MUST protect art_test.v1.mp4 because the open job still references it!
    const dryPrune = await store.pruneMedia('main', { keepVersions: 1, dryRun: true });
    expect(dryPrune.prunedFiles).not.toContain('art_test.v1.mp4');
    expect(dryPrune.keptFiles).toContain('art_test.v1.mp4');
    expect(dryPrune.keptFiles).toContain('art_test.v13.mp4');
  });
});

describe('B3 Hardening G3: Confirm conflict/validation, Catch up otherChanges/chain/ack, and 40-session/5000-event perf (H9-H13)', () => {
  it('H9: confirmArtifact rejects stale expectedAgainst (dec_001->002->003) and artifactVersion mismatch with ConflictError', async () => {
    const dir = await makeTempDir('cdeck-h9-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H9', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Use Cookies' });
    const diag = await store.upsertDiagram('main', {
      title: 'Auth Flow',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });
    const d2 = await store.recordDecision('main', { title: 'Use JWT', supersedes: d1.id });

    // Human views stale artifact showing d1 -> d2 at version 1, then d3 supersedes d2 before submit
    const d3 = await store.recordDecision('main', { title: 'Use Passkeys', supersedes: d2.id });

    await expect(
      store.confirmArtifact(
        'main',
        'diagram',
        diag.id,
        {
          note: 'I checked dec_002',
          artifactVersion: 1,
          expectedAgainst: { [d1.id]: d2.id },
        },
        { type: 'human', label: 'reviewer' },
      ),
    ).rejects.toThrow(core.ConflictError);

    // Confirming with wrong artifactVersion also throws ConflictError
    await expect(
      store.confirmArtifact(
        'main',
        'diagram',
        diag.id,
        {
          note: 'Checked against d3',
          artifactVersion: 99,
          expectedAgainst: { [d1.id]: d3.id },
        },
        { type: 'human', label: 'reviewer' },
      ),
    ).rejects.toThrow(core.ConflictError);

    // Confirming with matching version + expectedAgainst succeeds against d3
    const ok = await store.confirmArtifact(
      'main',
      'diagram',
      diag.id,
      {
        note: 'Checked against d3',
        artifactVersion: 1,
        expectedAgainst: { [d1.id]: d3.id },
      },
      { type: 'human', label: 'reviewer' },
    );
    expect(ok.confirmations[d1.id].againstDecisionId).toBe(d3.id);
  });

  it('H10: rejects whitespace-only note and rejects no-op confirmArtifact without bumping revision or appending events', async () => {
    const dir = await makeTempDir('cdeck-h10-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H10', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Active Decision' });
    const diag = await store.upsertDiagram('main', {
      title: 'Fresh Diagram',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });

    const beforeSnap = await store.getSnapshot('main');
    const beforeRev = beforeSnap.config.revision;
    const beforeEvents = beforeSnap.events.length;

    // Nothing is stale -> MUST throw ValidationError and NOT mutate revision or events
    await expect(
      store.confirmArtifact('main', 'diagram', diag.id, { note: 'nothing stale' }),
    ).rejects.toThrow(core.ValidationError);

    const afterNoOp = await store.getSnapshot('main');
    expect(afterNoOp.config.revision).toBe(beforeRev);
    expect(afterNoOp.events).toHaveLength(beforeEvents);

    // Supersede d1 -> blank whitespace-only note MUST throw ValidationError
    await store.recordDecision('main', { title: 'New Decision', supersedes: d1.id });
    await expect(
      store.confirmArtifact('main', 'diagram', diag.id, { note: '   ' }),
    ).rejects.toThrow(core.ValidationError);
  });

  it('H11: Catch up surfaces otherChanges (brief/diagram/task edits/deletes) capped at 20 and preserves non-empty invariant when hasUnseen is true', async () => {
    const dir = await makeTempDir('cdeck-h11-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H11', slug: 'main' });

    const initSnap = await store.getSnapshot('main');
    await store.ackReaderCursor('main', initSnap.config.revision, { readerId: 'reader_h11' });

    await store.updateBrief('main', '# Updated Brief', { type: 'agent', label: 'codex' });
    const cu = (await store.getCatchUp('main', { readerId: 'reader_h11' })) as core.CatchUpReport & {
      otherChanges?: Array<{ kind: string; title: string; actor: string; at: string }>;
      otherChangesTruncated?: number;
    };
    expect(cu.hasUnseen).toBe(true);
    expect(cu.unseenCount).toBe(1);
    expect(cu.otherChanges).toBeDefined();
    expect(cu.otherChanges!.length).toBe(1);
    expect(cu.otherChanges![0].kind).toBe('brief.updated');
    expect(cu.otherChanges![0].actor).toBe('codex');

    // Invariant: hasUnseen === true implies at least one surfaced item across all sections
    const totalRendered =
      cu.decisionsChanged.length +
      cu.staleArtifacts.length +
      cu.tasksMoved.length +
      cu.newSessions.length +
      (cu.otherChanges?.length ?? 0);
    expect(totalRendered).toBeGreaterThan(0);

    // Cap at 20 + truncated count
    for (let i = 0; i < 24; i += 1) {
      await store.updateBrief('main', `# Brief rev ${i}`, { type: 'agent', label: 'codex' });
    }
    const cuMany = (await store.getCatchUp('main', { readerId: 'reader_h11' })) as core.CatchUpReport & {
      otherChanges?: Array<{ kind: string; title: string; actor: string; at: string }>;
      otherChangesTruncated?: number;
    };
    expect(cuMany.otherChanges).toHaveLength(20);
    expect(cuMany.otherChangesTruncated).toBe(5);
  });

  it('H12: walks chain supersession back to pre-window decision and preserves concurrent hook sessions on ack via evaluatedAt/reviewedAt', async () => {
    const dir = await makeTempDir('cdeck-h12-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'H12', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Use Redis' });
    const snap1 = await store.getSnapshot('main');
    await store.ackReaderCursor('main', snap1.config.revision, { readerId: 'reader_h12' });

    // Chain supersession in one window: d1 -> d2 -> d3
    const d2 = await store.recordDecision('main', { title: 'Use SQLite', supersedes: d1.id });
    const d3 = await store.recordDecision('main', { title: 'Use Plain Files', supersedes: d2.id });

    const cuChain = (await store.getCatchUp('main', { readerId: 'reader_h12' })) as core.CatchUpReport & {
      evaluatedAt?: string;
    };
    expect(cuChain.decisionsChanged).toHaveLength(1);
    expect(cuChain.decisionsChanged[0].decisionId).toBe(d3.id);
    expect(cuChain.decisionsChanged[0].previousDecisionId).toBe(d1.id);
    expect(cuChain.decisionsChanged[0].previousTitle).toBe('Use Redis');
    expect(cuChain.evaluatedAt).toBeTruthy();

    // Ack race: hook creates a session AFTER cuChain was evaluated, BEFORE user clicks Mark caught up
    await new Promise((r) => setTimeout(r, 15));
    const hookRes = await store.upsertHookSession({
      externalRef: 'codex:race-session-1',
      harness: 'codex',
      defaultTitle: 'Concurrent Hook Session',
      cwd: dir,
    });
    await new Promise((r) => setTimeout(r, 15));

    await store.ackReaderCursor('main', cuChain.toRevision, {
      readerId: 'reader_h12',
      reviewedAt: cuChain.evaluatedAt,
    });

    const cuAfterAck = await store.getCatchUp('main', { readerId: 'reader_h12' });
    expect(cuAfterAck.hasUnseen).toBe(true);
    expect(cuAfterAck.newSessions.some((s) => s.sessionId === hookRes.session.id)).toBe(true);
  });

  it('H13: keeps caught-up getCatchUp < 50ms and behind-by-5000 hook digest < 300ms at 40 sessions / 5,000 events', async () => {
    const dir = await makeTempDir('cdeck-h13-');
    const store = new core.ContextDeckStore({ deckDir: path.join(dir, '.contextdeck'), projectRoot: dir });
    await store.createBoard({ title: 'Perf', slug: 'main' });

    const boardDir = store.boardPath('main');
    const nowIso = new Date().toISOString();

    // Seed 40 active sessions in workspace sessions dir + cursors
    const sessionsDir = path.join(store.deckDir, 'sessions');
    const cursorsDir = path.join(store.runtimeDir, 'cursors');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(cursorsDir, { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      const sid = `sess_perf_${String(i).padStart(2, '0')}`;
      const extRef = `claude-code:perf-${i}`;
      await fs.writeFile(
        path.join(sessionsDir, `${sid}.yaml`),
        `id: ${sid}\ntitle: Perf Session ${i}\nharness: claude-code\nexternalRef: "${extRef}"\nboard: main\nparentSessionId: null\nrelatedSessionIds: []\nstatus: active\nsummary: ""\nfocusFiles: []\ncreatedAt: "${nowIso}"\nupdatedAt: "${nowIso}"\n`,
        'utf8',
      );
      await fs.writeFile(
        path.join(cursorsDir, `${sid}.json`),
        JSON.stringify({ sessionId: sid, syncedRevisions: { main: 10 }, lastActiveAt: nowIso }),
        'utf8',
      );
    }

    // Seed 5,000 valid events in events.jsonl and update board.yaml revision to 5001
    const lines: string[] = [];
    for (let r = 2; r <= 5001; r += 1) {
      lines.push(
        JSON.stringify({
          id: `evt_${String(r).padStart(5, '0')}`,
          revision: r,
          timestamp: nowIso,
          actor: { type: 'agent', harness: 'codex', sessionId: 'sess_other' },
          kind: 'task.updated',
          entityId: `task_${(r % 20) + 1}`,
          summary: `Updated task ${(r % 20) + 1} at rev ${r}`,
        }),
      );
    }
    await fs.appendFile(path.join(boardDir, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const boardYamlPath = path.join(boardDir, 'board.yaml');
    const boardYaml = await fs.readFile(boardYamlPath, 'utf8');
    await fs.writeFile(boardYamlPath, boardYaml.replace(/revision:\s*\d+/, 'revision: 5001'), 'utf8');

    // Ack reader cursor at 5001 so caught-up path executes
    await store.ackReaderCursor('main', 5001, { readerId: 'reader_perf' });

    const ciFactor = Number(process.env.CONTEXTDECK_BENCH_FACTOR ?? '1') || 1;
    // Warm one call for module/git cache
    await store.getCatchUp('main', { readerId: 'reader_perf' });

    const tCatchUp0 = performance.now();
    const caughtUp = await store.getCatchUp('main', { readerId: 'reader_perf' });
    const catchUpMs = performance.now() - tCatchUp0;
    expect(caughtUp.hasUnseen).toBe(false);
    expect(catchUpMs).toBeLessThan(50 * ciFactor);

    // Measure behind-by-4991 hook sync digest
    const tHook0 = performance.now();
    const hookSync = await store.checkAndSyncHookDrift({
      externalRef: 'claude-code:perf-0',
      harness: 'claude-code',
      defaultTitle: 'Perf Session 0',
      cwd: dir,
    });
    const hookMs = performance.now() - tHook0;
    expect(hookSync.action).toBe('digest');
    expect(hookMs).toBeLessThan(300 * ciFactor);
  });
});
