import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

export type HarnessTarget = 'claude-code' | 'cursor' | 'codex' | 'agents-md';

async function readJsonSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeJsonPretty(filePath: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

const AGENTS_MD_SECTION = `<!-- contextdeck:start -->
## Shared Context Protocol (ContextDeck)

This project maintains a living, Git-backed shared context board in \`.contextdeck/\`.
Whenever you work in this repository (from Cursor, Claude Code, Codex, or any other harness):

1. **Orient first:** Call the \`board_get_brief\` MCP tool (or run \`cdeck brief --pack\`) to load the current mental model, active decisions, and open tasks.
2. **Register your session:** Call \`session_register\` (linking \`parentSessionId\` if continuing a parent thread) so your session appears in the Session Hierarchy graph.
3. **Record decisions & supersessions:** When architecture or direction changes, call \`decision_record\` (passing \`supersedes: "dec_xxx"\` when replacing an older choice) so outdated diagrams, videos, and quizzes are flagged stale.
4. **Update living artifacts:** Keep Kanban tasks (\`task_upsert\`), Mermaid/Excalidraw diagrams (\`diagram_upsert\`), reference media (\`media_attach\`), and knowledge-check quizzes (\`quiz_create\`) current.
<!-- contextdeck:end -->
`;

export async function setupHarness(
  rootDir: string,
  target: HarnessTarget,
  options: { cliCommand?: string; serverUrl?: string } = {},
): Promise<{ filesWritten: string[]; notes: string[] }> {
  const cliCmd = options.cliCommand ?? 'cdeck';
  const serverUrl = options.serverUrl ?? 'http://127.0.0.1:4310/mcp';
  const filesWritten: string[] = [];
  const notes: string[] = [];

  if (target === 'claude-code') {
    const mcpPath = path.join(rootDir, '.mcp.json');
    const existingMcp = await readJsonSafe(mcpPath);
    const mcpServers = (existingMcp.mcpServers as Record<string, unknown> | undefined) ?? {};
    mcpServers.contextdeck = {
      command: cliCmd,
      args: ['mcp', '--dir', rootDir],
    };
    await writeJsonPretty(mcpPath, { ...existingMcp, mcpServers });
    filesWritten.push(mcpPath);

    const claudeSettingsPath = path.join(rootDir, '.claude', 'settings.local.json');
    const existingSettings = await readJsonSafe(claudeSettingsPath);
    const hooks = (existingSettings.hooks as Record<string, unknown> | undefined) ?? {};
    hooks.SessionStart = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${cliCmd} status --brief-hook --dir "${rootDir}"`,
          },
        ],
      },
    ];
    await writeJsonPretty(claudeSettingsPath, { ...existingSettings, hooks });
    filesWritten.push(claudeSettingsPath);
    notes.push(
      'Configured stdio MCP server in .mcp.json and a SessionStart drift reminder hook in .claude/settings.local.json.',
    );
    return { filesWritten, notes };
  }

  if (target === 'cursor') {
    const cursorMcpPath = path.join(rootDir, '.cursor', 'mcp.json');
    const existing = await readJsonSafe(cursorMcpPath);
    const mcpServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    mcpServers.contextdeck = {
      command: cliCmd,
      args: ['mcp', '--dir', rootDir],
    };
    await writeJsonPretty(cursorMcpPath, { ...existing, mcpServers });
    filesWritten.push(cursorMcpPath);

    const rulePath = path.join(rootDir, '.cursor', 'rules', 'contextdeck.mdc');
    await fs.mkdir(path.dirname(rulePath), { recursive: true });
    await fs.writeFile(
      rulePath,
      `---
description: Keep Cursor sessions synchronized with the shared ContextDeck board
alwaysApply: true
---

${AGENTS_MD_SECTION}`,
      'utf8',
    );
    filesWritten.push(rulePath);
    notes.push(
      'Configured Cursor MCP server in .cursor/mcp.json and always-on sync rule in .cursor/rules/contextdeck.mdc.',
    );
    return { filesWritten, notes };
  }

  if (target === 'codex') {
    const snippetPath = path.join(rootDir, '.contextdeck', 'codex-mcp.toml');
    await fs.mkdir(path.dirname(snippetPath), { recursive: true });
    await fs.writeFile(
      snippetPath,
      `# Add to ~/.codex/config.toml (stdio or Streamable HTTP):\n[mcp_servers.contextdeck]\ncommand = "${cliCmd}"\nargs = ["mcp", "--dir", "${rootDir}"]\n\n# Or connect to a running ContextDeck web server:\n# [mcp_servers.contextdeck]\n# url = "${serverUrl}"\n`,
      'utf8',
    );
    filesWritten.push(snippetPath);
    notes.push(
      `Generated Codex MCP config snippet at ${snippetPath}. Paste it into ~/.codex/config.toml.`,
    );
    return { filesWritten, notes };
  }

  // agents-md
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  let content = '';
  if (existsSync(agentsPath)) {
    content = await fs.readFile(agentsPath, 'utf8');
    const pattern = /<!-- contextdeck:start -->[\s\S]*?<!-- contextdeck:end -->/;
    if (pattern.test(content)) {
      content = content.replace(pattern, AGENTS_MD_SECTION.trim());
    } else {
      content = `${content.trimEnd()}\n\n${AGENTS_MD_SECTION}`;
    }
  } else {
    content = `# Agent Guidelines\n\n${AGENTS_MD_SECTION}`;
  }
  await fs.writeFile(agentsPath, content, 'utf8');
  filesWritten.push(agentsPath);
  notes.push('Added universal ContextDeck protocol block to AGENTS.md.');
  return { filesWritten, notes };
}
