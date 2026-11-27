import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { CorruptDataError, NotFoundError, SecurityError } from './errors.js';
import { nowIso } from './ids.js';
import { atomicWriteFile } from './txn.js';
import { resolveContextDeckHome } from './workspace.js';

export const WORKER_CONFIG_FILENAME = 'worker.yaml';
export const WORKER_TRUST_FILENAME = 'worker-trust.json';

export const WorkerHandlerSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    timeoutSec: z.number().int().min(1).max(3600).default(300),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type WorkerHandlerConfig = z.infer<typeof WorkerHandlerSchema>;

export const WorkerConfigSchema = z
  .object({
    handlers: z.record(z.string().min(1), WorkerHandlerSchema).default({}),
  })
  .strict();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

const WorkerTrustSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    trustedAt: z.string().min(1),
    configPath: z.string().min(1),
  })
  .strict();

export interface LoadedWorkerConfig {
  configPath: string;
  trustPath: string;
  sha256: string;
  config: WorkerConfig;
}

export function resolveWorkerConfigPaths(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): { homeDir: string; configPath: string; trustPath: string } {
  const home = resolveContextDeckHome(options);
  return {
    homeDir: home,
    configPath: path.join(home, WORKER_CONFIG_FILENAME),
    trustPath: path.join(home, WORKER_TRUST_FILENAME),
  };
}

/**
 * Load and validate user-local `~/.contextdeck/worker.yaml` (D18).
 * Never reads handler commands from a repository directory.
 */
export async function loadWorkerConfig(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<LoadedWorkerConfig> {
  const { configPath, trustPath } = resolveWorkerConfigPaths(options);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError(
        `User-local worker config not found at "${configPath}". Create ~/.contextdeck/worker.yaml (see docs/handlers.md) and run \`cdeck worker trust\`.`,
      );
    }
    throw err;
  }

  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch (err) {
    throw new CorruptDataError(
      `Invalid YAML in "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = WorkerConfigSchema.safeParse(loaded);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'worker.yaml'}: ${i.message}`)
      .join('; ');
    throw new CorruptDataError(`Invalid worker config "${configPath}": ${msg}`);
  }

  const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  return {
    configPath,
    trustPath,
    sha256,
    config: parsed.data,
  };
}

/**
 * Trust the current hash of user-local `~/.contextdeck/worker.yaml` (D18).
 */
export async function trustWorkerConfig(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<{ configPath: string; trustPath: string; sha256: string; handlers: string[] }> {
  const loaded = await loadWorkerConfig(options);
  await fs.mkdir(path.dirname(loaded.trustPath), { recursive: true, mode: 0o700 });
  const trustPayload = {
    sha256: loaded.sha256,
    trustedAt: nowIso(),
    configPath: loaded.configPath,
  };
  await atomicWriteFile(loaded.trustPath, `${JSON.stringify(trustPayload, null, 2)}\n`, 0o600);
  return {
    configPath: loaded.configPath,
    trustPath: loaded.trustPath,
    sha256: loaded.sha256,
    handlers: Object.keys(loaded.config.handlers),
  };
}

/**
 * Verify that the loaded user-local `worker.yaml` matches the stored trust hash (D18).
 */
export async function assertWorkerConfigTrusted(loaded: LoadedWorkerConfig): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(loaded.trustPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SecurityError(
        `Worker config "${loaded.configPath}" has not been trusted yet. Review the handler commands and run \`cdeck worker trust\`.`,
      );
    }
    throw err;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new SecurityError(
      `Worker trust record "${loaded.trustPath}" is corrupt. Review "${loaded.configPath}" and re-run \`cdeck worker trust\`.`,
    );
  }

  const trust = WorkerTrustSchema.safeParse(parsedJson);
  if (!trust.success || trust.data.sha256 !== loaded.sha256) {
    throw new SecurityError(
      `Worker config "${loaded.configPath}" changed since it was last trusted. Review the handlers and re-run \`cdeck worker trust\`.`,
    );
  }
}
