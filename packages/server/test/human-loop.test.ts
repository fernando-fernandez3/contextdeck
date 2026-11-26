import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContextDeckStore } from '@contextdeck/core';
import { createApp } from '../src/app.js';
import { createContextDeckMcpServer } from '../src/mcp.js';

const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-b3-srv-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('B3 Server: REST catchup, confirmations, jobs, and versioned updates', () => {
  it('removes /artifacts/:type/:id/refresh, exposes /catchup + /reader/ack, human /confirm, and job REST lifecycle', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await store.createBoard({ title: 'Human Loop', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'Use Polling' });
    const diag = await store.upsertDiagram('main', {
      title: 'Sync Diagram',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->Polling',
      basedOnDecisions: [d1.id],
    });
    const d2 = await store.recordDecision('main', { title: 'Use SSE', supersedes: d1.id });

    const { app, token, close } = createApp({ store, port: 4310 });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
      // D17: Old refresh endpoint MUST NOT exist (404)
      const oldRefresh = await app.request(
        `http://127.0.0.1:4310/api/boards/main/artifacts/diagram/${diag.id}/refresh`,
        { method: 'POST', headers: auth },
      );
      expect(oldRefresh.status).toBe(404);

      // Catch up endpoint returns unseen changes
      const cu1Res = await app.request(
        'http://127.0.0.1:4310/api/boards/main/catchup?readerId=reader_test',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(cu1Res.status).toBe(200);
      const cu1 = (await cu1Res.json()) as {
        hasUnseen: boolean;
        toRevision: number;
        staleArtifacts: Array<{ artifactId: string }>;
      };
      expect(cu1.hasUnseen).toBe(true);
      expect(cu1.staleArtifacts.some((a) => a.artifactId === diag.id)).toBe(true);

      // Reader ack advances cursor without bumping board revision
      const ackRes = await app.request('http://127.0.0.1:4310/api/boards/main/reader/ack', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ revision: cu1.toRevision, readerId: 'reader_test' }),
      });
      expect(ackRes.status).toBe(200);
      const ackBody = (await ackRes.json()) as { catchUp: { hasUnseen: boolean } };
      expect(ackBody.catchUp.hasUnseen).toBe(false);

      // Create refresh job via REST (dedupes on second POST)
      const jobRes1 = await app.request('http://127.0.0.1:4310/api/boards/main/jobs', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ artifactType: 'diagram', artifactId: diag.id }),
      });
      expect(jobRes1.status).toBe(201);
      const created = (await jobRes1.json()) as { job: { id: string }; deduplicated: boolean };
      expect(created.deduplicated).toBe(false);

      const jobRes2 = await app.request('http://127.0.0.1:4310/api/boards/main/jobs', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ artifactType: 'diagram', artifactId: diag.id }),
      });
      expect(jobRes2.status).toBe(200);
      const dup = (await jobRes2.json()) as { job: { id: string }; deduplicated: boolean };
      expect(dup.deduplicated).toBe(true);
      expect(dup.job.id).toBe(created.job.id);

      // Human confirm via REST clears staleness without rewriting basedOnDecisions
      const confirmRes = await app.request(
        `http://127.0.0.1:4310/api/boards/main/artifacts/diagram/${diag.id}/confirm`,
        {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ note: 'Still accurate for overview' }),
        },
      );
      expect(confirmRes.status).toBe(200);
      const confirmed = (await confirmRes.json()) as {
        basedOnDecisions: string[];
        confirmations: Record<string, { againstDecisionId: string; actorType: string }>;
      };
      expect(confirmed.basedOnDecisions).toEqual([d1.id]);
      expect(confirmed.confirmations[d1.id].againstDecisionId).toBe(d2.id);
      expect(confirmed.confirmations[d1.id].actorType).toBe('human');

      // Task confirm rejected (D17)
      const taskConfirm = await app.request(
        'http://127.0.0.1:4310/api/boards/main/artifacts/task/task_001/confirm',
        { method: 'POST', headers: auth, body: JSON.stringify({}) },
      );
      expect(taskConfirm.status).toBe(400);

      // H1: REST multipart media PATCH threads leaseToken and enforces active claim
      const vidV1 = path.join(dir, 'rest-v1.mp4');
      await fs.writeFile(vidV1, Buffer.from('rest-v1-bytes'));
      const media = await store.addMedia('main', {
        title: 'REST Video',
        kind: 'video',
        sourceFilePath: vidV1,
        basedOnDecisions: [d1.id],
      });
      const { job: mJob } = await store.createRefreshJob('main', {
        artifactType: 'media',
        artifactId: media.id,
      });
      const claimedM = await store.claimJob('main', { jobId: mJob.id, claimedBy: 'rest-worker' });

      const badForm = new FormData();
      badForm.set('jobId', mJob.id);
      badForm.set('file', new Blob(['rest-v2-bytes'], { type: 'video/mp4' }), 'v2.mp4');
      const badMultipart = await app.request(
        `http://127.0.0.1:4310/api/boards/main/media/${media.id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: badForm,
        },
      );
      expect(badMultipart.status).toBe(400);

      const goodForm = new FormData();
      goodForm.set('jobId', mJob.id);
      goodForm.set('leaseToken', claimedM!.leaseToken!);
      goodForm.set('basedOnDecisions', d2.id);
      goodForm.set('file', new Blob(['rest-v2-bytes'], { type: 'video/mp4' }), 'v2.mp4');
      const goodMultipart = await app.request(
        `http://127.0.0.1:4310/api/boards/main/media/${media.id}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: goodForm,
        },
      );
      expect(goodMultipart.status).toBe(200);
      const patchedMedia = (await goodMultipart.json()) as { version: number; filePath: string };
      expect(patchedMedia.version).toBe(2);
      expect(patchedMedia.filePath).toBe(`${media.id}.v2.mp4`);

      const doneM = await app.request(
        `http://127.0.0.1:4310/api/boards/main/jobs/${mJob.id}/complete`,
        {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ leaseToken: claimedM!.leaseToken!, artifactVersion: 2 }),
        },
      );
      expect(doneM.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe('B3 Server: MCP artifact_confirm, job_*, media_update, quiz_update', () => {
  it('removes artifact_refresh, requires note & forces agent actorType on artifact_confirm, and runs full MCP job + media/quiz update lifecycle', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore({ deckDir: path.join(dir, '.contextdeck'), projectRoot: dir });
    await store.createBoard({ title: 'MCP B3', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Legacy Auth' });
    const d2 = await store.recordDecision('main', { title: 'OAuth PKCE', supersedes: d1.id });
    const mediaV1File = path.join(dir, 'explainer-v1.mp4');
    const mediaV2File = path.join(dir, 'explainer-v2.mp4');
    await fs.writeFile(mediaV1File, Buffer.from('v1-video'));
    await fs.writeFile(mediaV2File, Buffer.from('v2-video'));

    const media = await store.addMedia('main', {
      title: 'Auth Video',
      kind: 'video',
      sourceFilePath: mediaV1File,
      basedOnDecisions: [d1.id],
    });
    const quiz = await store.createQuiz('main', {
      title: 'Auth Quiz',
      basedOnDecisions: [d1.id],
      questions: [
        {
          id: 'q1',
          prompt: 'Old question?',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: 'Old',
          relatedDecisionIds: [d1.id],
        },
      ],
    });
    await store.submitQuizAttempt('main', quiz.id, { answers: { q1: 'true' } });

    const mcpServer = createContextDeckMcpServer(store, { defaultBoard: 'main' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'b3-mcp-test', version: '0.2.0' });

    try {
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

      // Verify artifact_refresh is gone and new B3 tools exist
      const listed = await client.listTools();
      const toolNames = listed.tools.map((t) => t.name);
      expect(toolNames).not.toContain('artifact_refresh');
      expect(toolNames).toContain('artifact_confirm');
      expect(toolNames).toContain('media_update');
      expect(toolNames).toContain('quiz_update');
      expect(toolNames).toContain('job_list');
      expect(toolNames).toContain('job_claim');
      expect(toolNames).toContain('job_renew');
      expect(toolNames).toContain('job_release');
      expect(toolNames).toContain('job_complete');

      // artifact_confirm requires note and records actorType === 'agent' (D14, AC7.3)
      const missingNote = await client.callTool({
        name: 'artifact_confirm',
        arguments: { artifactType: 'media', artifactId: media.id },
      });
      expect(missingNote.isError).toBe(true);

      const confirmOk = await client.callTool({
        name: 'artifact_confirm',
        arguments: {
          artifactType: 'media',
          artifactId: media.id,
          note: 'Checked video concepts against PKCE',
          harness: 'codex',
        },
      });
      expect(confirmOk.isError).not.toBe(true);
      const confirmedMedia = JSON.parse((confirmOk.content as Array<{ text: string }>)[0].text) as {
        confirmations: Record<string, { actorType: string; againstDecisionId: string }>;
      };
      expect(confirmedMedia.confirmations[d1.id].actorType).toBe('agent');
      expect(confirmedMedia.confirmations[d1.id].againstDecisionId).toBe(d2.id);

      // Queue media + quiz refresh jobs and drive claim -> renew -> update -> complete over MCP
      const { job: mediaJob } = await store.createRefreshJob('main', {
        artifactType: 'media',
        artifactId: media.id,
      });
      const { job: quizJob } = await store.createRefreshJob('main', {
        artifactType: 'quiz',
        artifactId: quiz.id,
      });

      const listRes = await client.callTool({ name: 'job_list', arguments: { status: 'queued' } });
      const listedJobs = JSON.parse((listRes.content as Array<{ text: string }>)[0].text) as Array<{ id: string }>;
      expect(listedJobs.map((j) => j.id)).toContain(mediaJob.id);

      const claimMedia = await client.callTool({
        name: 'job_claim',
        arguments: { jobId: mediaJob.id, claimedBy: 'agent-video' },
      });
      const claimedMediaJob = JSON.parse((claimMedia.content as Array<{ text: string }>)[0].text) as {
        leaseToken: string;
      };
      expect(claimedMediaJob.leaseToken).toBeTruthy();

      const renewRes = await client.callTool({
        name: 'job_renew',
        arguments: { jobId: mediaJob.id, leaseToken: claimedMediaJob.leaseToken },
      });
      expect(renewRes.isError).not.toBe(true);

      // Complete BEFORE media_update must fail!
      const badComplete = await client.callTool({
        name: 'job_complete',
        arguments: { jobId: mediaJob.id, leaseToken: claimedMediaJob.leaseToken },
      });
      expect(badComplete.isError).toBe(true);

      // media_update without leaseToken must fail (H1)
      const missingLeaseMedia = await client.callTool({
        name: 'media_update',
        arguments: {
          mediaId: media.id,
          sourceFilePath: mediaV2File,
          basedOnDecisions: [d2.id],
          jobId: mediaJob.id,
        },
      });
      expect(missingLeaseMedia.isError).toBe(true);

      // media_update with sourceFilePath + jobId + leaseToken bumps version to 2
      const updMediaRes = await client.callTool({
        name: 'media_update',
        arguments: {
          mediaId: media.id,
          sourceFilePath: mediaV2File,
          basedOnDecisions: [d2.id],
          jobId: mediaJob.id,
          leaseToken: claimedMediaJob.leaseToken,
        },
      });
      expect(updMediaRes.isError).not.toBe(true);
      const updatedMedia = JSON.parse((updMediaRes.content as Array<{ text: string }>)[0].text) as {
        version: number;
        filePath: string;
      };
      expect(updatedMedia.version).toBe(2);
      expect(updatedMedia.filePath).toBe(`${media.id}.v2.mp4`);

      const goodComplete = await client.callTool({
        name: 'job_complete',
        arguments: {
          jobId: mediaJob.id,
          leaseToken: claimedMediaJob.leaseToken,
          artifactVersion: 2,
          summary: 'Rendered v2',
        },
      });
      expect(goodComplete.isError).not.toBe(true);

      // Claim -> release -> reclaim quiz job, update quiz (preserving attempts!), and complete
      const claimQ1 = await client.callTool({
        name: 'job_claim',
        arguments: { jobId: quizJob.id, claimedBy: 'agent-quiz' },
      });
      const qLease1 = JSON.parse((claimQ1.content as Array<{ text: string }>)[0].text).leaseToken as string;
      await client.callTool({ name: 'job_release', arguments: { jobId: quizJob.id, leaseToken: qLease1 } });

      const claimQ2 = await client.callTool({
        name: 'job_claim',
        arguments: { jobId: quizJob.id, claimedBy: 'agent-quiz-2' },
      });
      const qLease2 = JSON.parse((claimQ2.content as Array<{ text: string }>)[0].text).leaseToken as string;

      const updQuizRes = await client.callTool({
        name: 'quiz_update',
        arguments: {
          quizId: quiz.id,
          basedOnDecisions: [d2.id],
          jobId: quizJob.id,
          leaseToken: qLease2,
          questions: [
            {
              id: 'q1',
              prompt: 'Does PKCE replace legacy auth?',
              type: 'true_false',
              correctAnswer: 'true',
              explanation: 'Yes per d2',
              relatedDecisionIds: [d2.id],
            },
          ],
        },
      });
      expect(updQuizRes.isError).not.toBe(true);
      const updatedQuiz = JSON.parse((updQuizRes.content as Array<{ text: string }>)[0].text) as {
        version: number;
        attempts: unknown[];
      };
      expect(updatedQuiz.version).toBe(2);
      expect(updatedQuiz.attempts).toHaveLength(1);

      const doneQuiz = await client.callTool({
        name: 'job_complete',
        arguments: { jobId: quizJob.id, leaseToken: qLease2, artifactVersion: 2 },
      });
      expect(doneQuiz.isError).not.toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
