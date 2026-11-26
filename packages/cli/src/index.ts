#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  ContextDeckStore,
  ValidationError,
  WorkspaceNotFoundError,
  ensureContextDeckGitignore,
  generateContextPack,
  initGlobalWorkspacePointer,
  resolveWorkspace,
  seedDemoBoard,
  validateBoardSlug,
  type Actor,
  type DecisionStatus,
  type DiagramKind,
  type MediaKind,
  type TaskColumn,
  type TaskPriority,
} from '@contextdeck/core';
import { runHookCli } from './hooks.js';
import { setupHarness, type HarnessTarget } from './setup.js';

// Fast-path hook execution: avoids Commander error output and lazy-loads server deps,
// guaranteeing silent exit 0 on unknown harness/event or any runtime failure (C5, D12).
if (process.argv[2] === 'hook') {
  runHookCli(process.argv[3], process.argv[4])
    .catch(() => {})
    .finally(() => {
      process.exit(0);
    });
} else {
const program = new Command();

program
  .name('cdeck')
  .description('ContextDeck — Local-first, Git-backed shared context board for humans and AI agents')
  .version('0.2.0');

function parseStrictIntFlag(raw: unknown, flagName: string, min: number, max?: number): number {
  const str = String(raw).trim();
  if (!/^-?\d+$/.test(str)) {
    throw new ValidationError(
      `Invalid value "${str}" for ${flagName}: expected an integer >= ${min}.`,
    );
  }
  const value = Number(str);
  if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new ValidationError(
      `Invalid value "${str}" for ${flagName}: expected an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ''}.`,
    );
  }
  return value;
}

function resolveStore(dir?: string): { store: ContextDeckStore; defaultBoard?: string } {
  const resolved = resolveWorkspace({ dir });
  return {
    store: new ContextDeckStore({
      deckDir: resolved.deckDir,
      projectRoot: resolved.projectRoot,
      defaultBoard: resolved.defaultBoard,
    }),
    defaultBoard: resolved.defaultBoard,
  };
}

async function resolveTargetBoard(
  store: ContextDeckStore,
  explicitBoard: string | undefined,
  sessionId: string | undefined,
  defaultBoard: string | undefined,
): Promise<string | undefined> {
  if (explicitBoard) return explicitBoard;
  if (sessionId) {
    const sess = await store.getSession(sessionId);
    if (sess?.board) return sess.board;
  }
  return defaultBoard;
}

program
  .command('hook <harness> <event>')
  .description('Handle harness lifecycle hooks (claude-code | codex | cursor)')
  .action(async (harness: string, event: string) => {
    await runHookCli(harness, event);
  });

program
  .command('init')
  .description('Initialize a .contextdeck workspace (in-repo or via --global <name> pointer)')
  .option('-d, --dir <path>', 'Project directory')
  .option('-t, --title <title>', 'Default board title', 'Project Context')
  .option('-s, --slug <slug>', 'Default board slug', 'main')
  .option('-g, --global <name>', 'Store workspace under ~/.contextdeck/workspaces/<name> and write .contextdeck.yaml pointer')
  .option('--demo', 'Also seed the interactive Realtime Sync Engine v2 demo board')
  .action(async (opts) => {
    const targetDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
    const boardSlug = opts.demo ? 'realtime-sync-v2' : validateBoardSlug(opts.slug);

    if (opts.global) {
      const resolved = await initGlobalWorkspacePointer({
        projectRoot: targetDir,
        workspaceName: String(opts.global),
        boardSlug,
      });
      const store = new ContextDeckStore({
        deckDir: resolved.deckDir,
        projectRoot: resolved.projectRoot,
        defaultBoard: resolved.defaultBoard,
      });
      if (opts.demo) {
        const demoSlug = await seedDemoBoard(store);
        console.log(
          `Initialized global ContextDeck "${resolved.workspaceName}" with demo board "${demoSlug}" (pointer: ${resolved.pointerPath})`,
        );
        return;
      }
      const board = await store.createBoard({
        title: opts.title,
        slug: boardSlug,
        setAsDefault: true,
      });
      console.log(
        `Initialized global ContextDeck "${resolved.workspaceName}" board "${board.title}" (${board.slug}) (pointer: ${resolved.pointerPath})`,
      );
      return;
    }

    const store = new ContextDeckStore({
      deckDir: path.join(targetDir, '.contextdeck'),
      projectRoot: targetDir,
    });
    if (opts.demo) {
      const demoSlug = await seedDemoBoard(store);
      await ensureContextDeckGitignore(targetDir);
      console.log(`Initialized ContextDeck with demo board "${demoSlug}" in ${store.deckDir}`);
      return;
    }
    const board = await store.createBoard({
      title: opts.title,
      slug: boardSlug,
      setAsDefault: true,
    });
    await ensureContextDeckGitignore(targetDir);
    console.log(`Initialized ContextDeck board "${board.title}" (${board.slug}) in ${store.deckDir}`);
  });

program
  .command('serve')
  .description('Start the local ContextDeck web UI, REST/SSE API, and Streamable HTTP MCP server')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-p, --port <number>', 'Port to listen on', '4310')
  .option('-H, --host <host>', 'Host to bind', '127.0.0.1')
  .option('--allow-remote', 'Allow binding a non-loopback host or custom --allowed-hosts (plain HTTP)', false)
  .option('--allowed-hosts <csv>', 'Comma-separated additional allowed Host headers (requires --allow-remote)')
  .option('--demo', 'Seed the demo board if the workspace is empty or uninitialized')
  .action(async (opts) => {
    let store: ContextDeckStore;
    let defaultBoard: string | undefined;

    try {
      const resolved = resolveStore(opts.dir);
      store = resolved.store;
      defaultBoard = resolved.defaultBoard;
    } catch (err) {
      if (opts.demo && err instanceof WorkspaceNotFoundError) {
        const targetDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
        store = new ContextDeckStore({
          deckDir: path.join(targetDir, '.contextdeck'),
          projectRoot: targetDir,
        });
        await seedDemoBoard(store);
        await ensureContextDeckGitignore(targetDir);
      } else {
        throw err;
      }
    }

    if (opts.demo && (await store.listBoards()).length === 0) {
      await seedDemoBoard(store);
    }

    const allowedHosts = opts.allowedHosts
      ? String(opts.allowedHosts)
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean)
      : [];

    const { startServer } = await import('@contextdeck/server');
    const srv = await startServer({
      deckDir: store.deckDir,
      projectRoot: store.projectRoot,
      defaultBoard,
      port: Number.parseInt(opts.port, 10),
      host: opts.host,
      allowRemote: Boolean(opts.allowRemote),
      allowedHosts,
    });
    console.log(`ContextDeck running:`);
    console.log(`  Launch URL   : ${srv.launchUrl}`);
    console.log(`  Web UI & API : ${srv.url}`);
    console.log(`  MCP (HTTP)   : ${srv.mcpUrl}`);
    console.log(`  Workspace    : ${store.deckDir}`);
    console.log(`  Tip          : Launch URL is single-use (120s). Run \`cdeck open\` anytime for a new one.`);

    const shutdown = async () => {
      await srv.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('open')
  .description('Mint and print a fresh single-use browser launch URL for a running ContextDeck server')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-p, --port <number>', 'Port where ContextDeck server is running', '4310')
  .option('-H, --host <host>', 'Host where ContextDeck server is running', '127.0.0.1')
  .action(async (opts) => {
    const { store } = resolveStore(opts.dir);
    const { formatHostForUrl, readWorkspaceToken } = await import('@contextdeck/server');
    const token = await readWorkspaceToken(store.runtimeDir);
    const port = Number.parseInt(opts.port, 10);
    const hostUrl = formatHostForUrl(String(opts.host));
    const baseUrl = `http://${hostUrl}:${port}`;
    const res = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Failed to mint launch URL from ${baseUrl} (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { path: string };
    console.log(`${baseUrl}${data.path}`);
  });

program
  .command('mcp')
  .description('Run ContextDeck as a stdio MCP server (for Cursor, Claude Code, Codex, etc.)')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Default board slug')
  .action(async (opts) => {
    // D4 / D9: Resolve workspace via E4; never auto-initialize
    const { store, defaultBoard } = resolveStore(opts.dir);
    const { startStdioMcpServer } = await import('@contextdeck/server');
    await startStdioMcpServer(store, opts.board ?? defaultBoard);
  });

program
  .command('status')
  .description('Show current board revision, session drift, and stale artifacts')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--brief-hook', 'Print a concise hook-friendly summary (exits 0 even if uninitialized)')
  .action(async (opts) => {
    let store: ContextDeckStore;
    let defaultBoard: string | undefined;
    try {
      const resolved = resolveStore(opts.dir);
      store = resolved.store;
      defaultBoard = resolved.defaultBoard;
    } catch (err) {
      if (opts.briefHook) return;
      console.log(err instanceof Error ? err.message : 'No ContextDeck workspace found. Run `cdeck init`.');
      return;
    }
    if (!store.isInitialized()) {
      if (opts.briefHook) return;
      console.log('No .contextdeck workspace found. Run `cdeck init` or `cdeck init --demo`.');
      return;
    }
    const snapshot = await store.getSnapshot(opts.board ?? defaultBoard);
    if (opts.briefHook) {
      console.log(
        `[ContextDeck] Board "${snapshot.config.title}" (${snapshot.config.slug}) is at rev ${snapshot.config.revision} | ${snapshot.decisions.filter((d) => d.status === 'accepted').length} active decisions | ${snapshot.drift.staleArtifacts.length} stale artifacts | ${snapshot.drift.driftedSessions.length} drifted sessions. Call board_get_brief to sync.`,
      );
      return;
    }
    console.log(`Board: ${snapshot.config.title} (${snapshot.config.slug}) — rev ${snapshot.config.revision}`);
    console.log(`Sessions: ${snapshot.sessions.length} (${snapshot.drift.driftedSessions.length} behind)`);
    console.log(`Decisions: ${snapshot.decisions.length}`);
    console.log(
      `Tasks: ${snapshot.tasks.length} | Diagrams: ${snapshot.diagrams.length} | Media: ${snapshot.media.length} | Quizzes: ${snapshot.quizzes.length}`,
    );
    if (snapshot.drift.staleArtifacts.length > 0) {
      console.log('\nStale Artifacts:');
      for (const s of snapshot.drift.staleArtifacts) {
        console.log(`  - [${s.artifactType}] ${s.title} (${s.artifactId}): ${s.reasons.join('; ')}`);
      }
    }
    if (snapshot.drift.driftedSessions.length > 0) {
      console.log('\nDrifted Sessions:');
      for (const ds of snapshot.drift.driftedSessions) {
        console.log(`  - ${ds.sessionId} [${ds.harness}] ${ds.title}: behind by ${ds.behindBy}`);
      }
    }
  });

program
  .command('brief')
  .description('Print or update the living brief, or emit a copy-ready Context Pack')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--pack', 'Output full Context Pack including active decisions, tasks, and web-chat update protocol')
  .option('--set <markdown>', 'Update the living brief text')
  .option('--file <path>', 'Update the living brief from a Markdown file')
  .option('--base-revision <n>', 'Expected board revision for optimistic concurrency check')
  .option('--session <sessionId>', 'Originating session ID')
  .action(async (opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const board = await resolveTargetBoard(store, opts.board, opts.session, defaultBoard);
    if (opts.set !== undefined || opts.file !== undefined) {
      const nextBrief =
        opts.file !== undefined ? await fs.readFile(path.resolve(opts.file), 'utf8') : String(opts.set);
      const baseRevision =
        opts.baseRevision !== undefined
          ? parseStrictIntFlag(opts.baseRevision, '--base-revision', 1)
          : undefined;
      const actor: Actor = opts.session
        ? { type: 'agent', sessionId: String(opts.session), label: 'cli' }
        : { type: 'human', label: 'cli' };
      const res = await store.updateBrief(board, nextBrief, actor, { baseRevision });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const snapshot = await store.getSnapshot(board);
    if (opts.pack) {
      console.log(generateContextPack(snapshot, { includeUpdateProtocol: true }));
    } else {
      console.log(snapshot.brief);
    }
  });

// Board subcommands
const boardCmd = program.command('board').description('Manage topic/project boards');
boardCmd
  .command('list')
  .option('-d, --dir <path>', 'Workspace directory')
  .action(async (opts) => {
    const { store } = resolveStore(opts.dir);
    const boards = await store.listBoards();
    const def = await store.getDefaultBoardSlug();
    for (const b of boards) {
      console.log(`${b.slug === def ? '*' : ' '} ${b.slug} — ${b.title} (rev ${b.revision})`);
    }
  });

boardCmd
  .command('create <title>')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-s, --slug <slug>', 'Custom slug')
  .option('--description <text>', 'Description')
  .option('--parent <slug>', 'Parent board slug')
  .option('--paths <csv>', 'Comma-separated relative path globs for automatic hook routing')
  .action(async (title, opts) => {
    const { store } = resolveStore(opts.dir);
    const paths = opts.paths
      ? String(opts.paths)
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;
    const b = await store.createBoard({
      title,
      slug: opts.slug,
      description: opts.description,
      ...(opts.parent ? { parentBoard: String(opts.parent) } : {}),
      ...(paths && paths.length > 0 ? { paths } : {}),
    });
    console.log(`Created board "${b.title}" (${b.slug})`);
  });

boardCmd
  .command('use <slug>')
  .description('Switch the workspace default board, or rebind a specific session to a board (AC6.4)')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('--session <sessionId>', 'Rebind this session ID instead of changing the workspace default')
  .action(async (slug: string, opts) => {
    const { store } = resolveStore(opts.dir);
    const validSlug = validateBoardSlug(slug);
    await store.readBoardConfig(validSlug);
    if (opts.session) {
      const rebound = await store.rebindSession(String(opts.session), validSlug, {
        type: 'human',
        label: 'cli',
      });
      console.log(JSON.stringify(rebound, null, 2));
      return;
    }
    await store.setDefaultBoard(validSlug);
    console.log(`Switched default board to "${validSlug}".`);
  });

// Session subcommands
const sessionCmd = program.command('session').description('Register or sync agent sessions');
sessionCmd
  .command('register <title>')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--harness <name>', 'Agent harness (cursor, claude-code, codex, grok, skill, etc.)', 'custom')
  .option('--parent <sessionId>', 'Parent session ID')
  .option('--summary <text>', 'Session summary')
  .action(async (title, opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const s = await store.registerSession(opts.board ?? defaultBoard, {
      title,
      harness: opts.harness,
      parentSessionId: opts.parent ?? null,
      summary: opts.summary,
    });
    console.log(JSON.stringify(s, null, 2));
  });

sessionCmd
  .command('sync <sessionId>')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--ack-revision <n>', 'Acknowledge a specific board revision')
  .action(async (sessionId, opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const ackRevision =
      opts.ackRevision !== undefined
        ? parseStrictIntFlag(opts.ackRevision, '--ack-revision', 0)
        : undefined;
    const board = await resolveTargetBoard(store, opts.board, sessionId, defaultBoard);
    const res = await store.syncSession(board, sessionId, { ackRevision });
    console.log(JSON.stringify(res, null, 2));
  });

// Decision subcommands
const decisionCmd = program.command('decision').description('Record or list decisions');
decisionCmd
  .command('add <title>')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--summary <text>', 'One-line summary', '')
  .option('--rationale <text>', 'Detailed rationale', '')
  .option('--status <status>', 'proposed | accepted | deprecated', 'accepted')
  .option('--supersedes <decisionId>', 'Decision ID superseded by this decision')
  .option('--session <sessionId>', 'Originating session ID')
  .option('--tags <csv>', 'Comma-separated tags')
  .action(async (title, opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const board = await resolveTargetBoard(store, opts.board, opts.session, defaultBoard);
    const actor: Actor = opts.session
      ? { type: 'agent', sessionId: String(opts.session), label: 'cli' }
      : { type: 'human', label: 'cli' };
    const dec = await store.recordDecision(
      board,
      {
        title,
        summary: opts.summary,
        rationale: opts.rationale,
        status: opts.status as DecisionStatus,
        supersedes: opts.supersedes ?? null,
        sessionId: opts.session ?? null,
        tags: opts.tags ? String(opts.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
      },
      actor,
    );
    console.log(JSON.stringify(dec, null, 2));
  });

// Task subcommands
const taskCmd = program.command('task').description('Create or move Kanban tasks');
taskCmd
  .command('add <title>')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--column <col>', 'backlog | in_progress | in_review | done', 'backlog')
  .option('--priority <prio>', 'low | medium | high | urgent', 'medium')
  .option('--assignee <name>', 'Assignee', 'unassigned')
  .option('--based-on <csv>', 'Comma-separated linked decision IDs')
  .option('--session <sessionId>', 'Originating session ID')
  .option('--description <text>', 'Description', '')
  .action(async (title, opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const board = await resolveTargetBoard(store, opts.board, opts.session, defaultBoard);
    const actor: Actor = opts.session
      ? { type: 'agent', sessionId: String(opts.session), label: 'cli' }
      : { type: 'human', label: 'cli' };
    const task = await store.upsertTask(
      board,
      {
        title,
        column: opts.column as TaskColumn,
        priority: opts.priority as TaskPriority,
        assignee: opts.assignee,
        linkedDecisionIds: opts.basedOn
          ? String(opts.basedOn).split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        description: opts.description,
      },
      actor,
    );
    console.log(JSON.stringify(task, null, 2));
  });

// Diagram subcommand
const diagramCmd = program.command('diagram').description('Attach Mermaid or Excalidraw diagrams');
diagramCmd
  .command('add <title>')
  .requiredOption('--file <path>', 'Path to .mmd or .excalidraw file')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--kind <kind>', 'mermaid | excalidraw', 'mermaid')
  .option('--based-on <csv>', 'Comma-separated decision IDs')
  .option('--session <sessionId>', 'Originating session ID')
  .action(async (title, opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const board = await resolveTargetBoard(store, opts.board, opts.session, defaultBoard);
    const content = await fs.readFile(path.resolve(opts.file), 'utf8');
    const actor: Actor = opts.session
      ? { type: 'agent', sessionId: String(opts.session), label: 'cli' }
      : { type: 'human', label: 'cli' };
    const diag = await store.upsertDiagram(
      board,
      {
        title,
        kind: opts.kind as DiagramKind,
        content,
        sessionId: opts.session ?? null,
        basedOnDecisions: opts.basedOn
          ? String(opts.basedOn).split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      },
      actor,
    );
    console.log(JSON.stringify(diag, null, 2));
  });

// Media subcommand (CLI keeps arbitrary readable paths for human intent per AC2.5)
const mediaCmd = program.command('media').description('Attach videos, audio, docs, or custom artifacts');
mediaCmd
  .command('add <title>')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--type <kind>', 'video | audio | doc | link | html | json | custom', 'video')
  .option('--file <path>', 'Local file to copy into the board')
  .option('--url <url>', 'External URL')
  .option('--transcript <text>', 'Transcript text or path to .txt/.md file')
  .option('--based-on <csv>', 'Comma-separated decision IDs')
  .option('--tags <csv>', 'Comma-separated tags')
  .option('--session <sessionId>', 'Originating session ID')
  .action(async (title, opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const board = await resolveTargetBoard(store, opts.board, opts.session, defaultBoard);
    let transcript = opts.transcript as string | undefined;
    if (transcript && (transcript.endsWith('.txt') || transcript.endsWith('.md'))) {
      try {
        transcript = await fs.readFile(path.resolve(transcript), 'utf8');
      } catch {
        // treat as literal text
      }
    }
    const actor: Actor = opts.session
      ? { type: 'agent', sessionId: String(opts.session), label: 'cli' }
      : { type: 'human', label: 'cli' };
    const artifact = await store.addMedia(
      board,
      {
        title,
        kind: opts.type as MediaKind,
        sourceFilePath: opts.file ? path.resolve(opts.file) : undefined,
        externalUrl: opts.url,
        transcript,
        sessionId: opts.session ?? null,
        basedOnDecisions: opts.basedOn
          ? String(opts.basedOn).split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        tags: opts.tags ? String(opts.tags).split(',').map((s) => s.trim()).filter(Boolean) : [],
      },
      actor,
    );
    console.log(JSON.stringify(artifact, null, 2));
  });

// Quiz subcommand
const quizCmd = program.command('quiz').description('Publish interactive quizzes to the board');
quizCmd
  .command('add')
  .requiredOption('--file <path>', 'Path to a quiz JSON file')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('-b, --board <slug>', 'Board slug')
  .option('--session <sessionId>', 'Originating session ID')
  .action(async (opts) => {
    const { store, defaultBoard } = resolveStore(opts.dir);
    const board = await resolveTargetBoard(store, opts.board, opts.session, defaultBoard);
    const raw = JSON.parse(await fs.readFile(path.resolve(opts.file), 'utf8'));
    const actor: Actor = opts.session
      ? { type: 'agent', sessionId: String(opts.session), label: 'cli' }
      : { type: 'human', label: 'cli' };
    const quiz = await store.createQuiz(board, raw, actor);
    console.log(JSON.stringify(quiz, null, 2));
  });

// Setup harness adapters
program
  .command('setup <harness>')
  .description('Configure harness integration (claude-code | cursor | codex | agents-md)')
  .option('-d, --dir <path>', 'Workspace directory')
  .option('--cli <cmd>', 'CLI command name for MCP config', 'cdeck')
  .action(async (harness: string, opts) => {
    const valid: HarnessTarget[] = ['claude-code', 'cursor', 'codex', 'agents-md'];
    if (!valid.includes(harness as HarnessTarget)) {
      console.error(`Unknown harness "${harness}". Choose one of: ${valid.join(', ')}`);
      process.exit(1);
    }
    const rootDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
    const res = await setupHarness(rootDir, harness as HarnessTarget, { cliCommand: opts.cli });
    console.log(`Configured ${harness}:`);
    for (const f of res.filesWritten) console.log(`  wrote ${f}`);
    for (const n of res.notes) console.log(`  note: ${n}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
}
