# Refresh Job Handlers (`cdeck worker`)

When a decision is superseded in ContextDeck, dependent diagrams, explainer videos, docs, and quizzes are flagged **Stale**. Clicking **Queue refresh** (or running `cdeck job create`) writes a plain YAML refresh job under `.contextdeck/boards/<slug>/jobs/<jobId>.yaml`.

Refresh jobs can be fulfilled in two ways:
1. **By a connected coding agent** (Claude Code, Codex, Cursor, Grok, Antigravity) — queued jobs appear in the Context Pack (`## Queued Refresh Jobs`) and hook digests; agents call `job_claim`, publish a new artifact version referencing `jobId`, and call `job_complete`.
2. **By a local worker** (`cdeck worker`) — runs user-configured local scripts or skills (video generators, quiz generators, diagram pipelines) on your machine.

---

## Security Model

- **The ContextDeck server never executes commands.** HTTP/MCP clients can queue or claim jobs, never run shell commands.
- **User-local config only.** `cdeck worker` reads handler definitions strictly from `~/.contextdeck/worker.yaml` (never from any repository or `.contextdeck/` directory).
- **Explicit trust gate.** Before executing handlers, you must approve `~/.contextdeck/worker.yaml` with `cdeck worker trust`. ContextDeck stores the SHA-256 hash of `worker.yaml` in `~/.contextdeck/worker-trust.json` (mode `0600`). Any edit to `worker.yaml` invalidates trust until you re-run `cdeck worker trust`.
- **No shell interpolation.** Handlers are specified as `argv` arrays and executed via `spawn(argv[0], argv.slice(1), { shell: false })`. Job details are passed via environment variables and a mode-`0600` temporary JSON file — never interpolated into a shell string.
- **Atomic leases & timeouts.** Each claimed job gets a lease token with a 15-minute TTL (automatically renewed every 5 minutes while a handler runs) and an explicit per-handler `timeoutSec` (SIGTERM followed by SIGKILL).
- **Verified completion.** A job can only be marked `done` when the target artifact has a strictly newer version (`version > baseVersion`) whose version history entry was created by that exact `jobId`.

---

## Configuration (`~/.contextdeck/worker.yaml`)

Create `~/.contextdeck/worker.yaml`:

```yaml
handlers:
  # Specific media kind match (checked before generic "media")
  "media:video":
    argv: ["node", "./scripts/refresh-video-explainer.mjs"]
    timeoutSec: 600
    cwd: "."

  # Quiz regeneration handler
  quiz:
    argv: ["node", "./scripts/refresh-quiz.mjs"]
    timeoutSec: 180

  # Optional fallback for diagrams or other media
  diagram:
    argv: ["node", "./scripts/refresh-diagram.mjs"]
    timeoutSec: 120
```

Handler lookup priority for a job:
1. For `media` artifacts: `media:<kind>` (e.g. `media:video`, `media:doc`) → `media` → `*`
2. For `diagram` artifacts: `diagram` → `*`
3. For `quiz` artifacts: `quiz` → `*`

Approve and run the worker:

```bash
cdeck worker trust
# Process currently queued jobs once and exit:
cdeck worker --once
# Or run continuously, polling every 5 seconds:
cdeck worker --interval 5
```

---

## Handler Input Contract

Every handler process receives the following environment variables:

| Variable | Value |
| :--- | :--- |
| `CONTEXTDECK_JOB_FILE` | Path to a temporary mode-`0600` JSON payload file (deleted automatically after handler exit) |
| `CONTEXTDECK_JOB_ID` | Claimed refresh job ID (e.g. `job_...`) |
| `CONTEXTDECK_LEASE_TOKEN` | Active lease token for the claimed job |
| `CONTEXTDECK_BOARD` | Target board slug |
| `CONTEXTDECK_ARTIFACT_TYPE` | `diagram`, `media`, or `quiz` |
| `CONTEXTDECK_ARTIFACT_ID` | Artifact ID to refresh |
| `CONTEXTDECK_BASE_VERSION` | Artifact version at the time the job was queued |
| `CONTEXTDECK_DECK_DIR` | Resolved `.contextdeck` workspace directory |
| `CONTEXTDECK_PROJECT_ROOT` | Resolved project root directory |

The JSON file at `CONTEXTDECK_JOB_FILE` has the shape:

```json
{
  "job": {
    "id": "job_abc123",
    "artifactType": "media",
    "artifactId": "art_explainer",
    "baseVersion": 1,
    "reason": "dec_001 superseded by dec_003"
  },
  "boardSlug": "my-board",
  "deckDir": "/path/to/.contextdeck",
  "projectRoot": "/path/to/project",
  "artifact": { "...": "full current artifact object" },
  "decisions": [
    { "id": "dec_003", "title": "...", "status": "accepted", "summary": "..." }
  ]
}
```

When the handler exits with code `0`, `cdeck worker` inspects the updated artifact, verifies `version > baseVersion` and `createdByJob === job.id`, and automatically marks the job `done`. If the handler exits non-zero, times out, or fails to publish a new version linked to `CONTEXTDECK_JOB_ID`, the worker marks the job `failed` with the captured stderr/error summary.

---

## Example 1: Video-Explainer Skill Handler (`media:video`)

This handler reads the job JSON, extracts the latest accepted decisions, runs a local video-explainer generator script, and publishes the next immutable version (`<id>.v<N>.mp4`) via `cdeck media update`:

```js
#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const payload = JSON.parse(await fs.readFile(process.env.CONTEXTDECK_JOB_FILE, 'utf8'));
const acceptedDecisions = payload.decisions.filter((d) => d.status === 'accepted');
const decisionIds = acceptedDecisions.map((d) => d.id).join(',');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-refresh-'));
const promptPath = path.join(workDir, 'brief.md');
const outVideo = path.join(workDir, 'explainer.mp4');
const outTranscript = path.join(workDir, 'transcript.txt');

try {
  const brief = [
    `# Refresh Explainer: ${payload.artifact.title}`,
    '',
    '## Current Accepted Decisions',
    ...acceptedDecisions.map((d) => `- ${d.id}: ${d.title} — ${d.summary}`),
  ].join('\n');
  await fs.writeFile(promptPath, brief, 'utf8');

  // Invoke your local video-explainer CLI/skill (replace with your generator command)
  execFileSync('my-video-explainer', [
    '--input', promptPath,
    '--out-video', outVideo,
    '--out-transcript', outTranscript,
  ], { stdio: 'inherit' });

  // Publish immutable v<N> and link it to the claimed refresh job
  execFileSync('cdeck', [
    'media', 'update', payload.job.artifactId,
    '--dir', payload.projectRoot,
    '--board', payload.boardSlug,
    '--file', outVideo,
    '--transcript', outTranscript,
    '--based-on', decisionIds,
    '--job', process.env.CONTEXTDECK_JOB_ID,
    '--note', `Regenerated for ${decisionIds}`,
  ], { stdio: 'inherit' });
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
```

---

## Example 2: Quiz Generator Skill Handler (`quiz`)

This handler regenerates stale quiz questions against the current accepted decisions and updates the quiz in place with `cdeck quiz update`, preserving all past human mastery attempts:

```js
#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const payload = JSON.parse(await fs.readFile(process.env.CONTEXTDECK_JOB_FILE, 'utf8'));
const acceptedDecisions = payload.decisions.filter((d) => d.status === 'accepted');
const decisionIds = acceptedDecisions.map((d) => d.id);

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiz-refresh-'));
const outQuizJson = path.join(workDir, 'quiz.json');

try {
  // Invoke your local quiz generator skill, or produce a quiz JSON file matching ContextDeck's schema
  execFileSync('my-quiz-generator', [
    '--job-file', process.env.CONTEXTDECK_JOB_FILE,
    '--out', outQuizJson,
  ], { stdio: 'inherit' });

  // Ensure basedOnDecisions reflects current accepted decisions
  const generated = JSON.parse(await fs.readFile(outQuizJson, 'utf8'));
  generated.basedOnDecisions = generated.basedOnDecisions ?? decisionIds;
  await fs.writeFile(outQuizJson, JSON.stringify(generated, null, 2), 'utf8');

  // Publish v<N> while preserving existing human mastery attempts
  execFileSync('cdeck', [
    'quiz', 'update', payload.job.artifactId,
    '--dir', payload.projectRoot,
    '--board', payload.boardSlug,
    '--file', outQuizJson,
    '--job', process.env.CONTEXTDECK_JOB_ID,
    '--note', 'Refreshed stale questions for updated decisions',
  ], { stdio: 'inherit' });
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
```

---

## Managing Jobs & Pruning Old Versions

```bash
# Inspect queued, claimed, completed, or failed jobs
cdeck job list
cdeck job list --status queued

# Queue a refresh job manually from the CLI
cdeck job create media art_explainer --reason "Decision dec_003 superseded dec_001"

# Preview and prune superseded media files (open-job versions are always protected)
cdeck media prune --dry-run
cdeck media prune --keep 2
```
