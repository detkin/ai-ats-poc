/**
 * lib/config.ts — environment knobs and the frozen clock (block B0.5).
 *
 * Owns: the single place that reads `TL_*` environment variables and turns them
 * into a validated, immutable `Config`. Nothing else in `lib/` or `bin/` may read
 * `process.env` for these knobs, and nothing resolves paths from the current
 * working directory: the repo root is found by walking up from `import.meta.url`
 * so a CLI run from any directory behaves identically. Plan §0 (env knobs),
 * DECISIONS D8 (frozen clock via `TL_NOW`).
 *
 * Public interface:
 *   ENV_KEYS                          -- the env var names, as a const record
 *   ADAPTER_MODES, AdapterMode        -- 'fixture' | 'rippling'
 *   DEFAULT_LOCK_STALE_MS             -- 10 minutes
 *   Config                            -- the resolved shape
 *   loadConfig(env = process.env)     -- throws ConfigError on any bad value
 *   now(config)                       -- a fresh Date of the (possibly frozen) instant
 *   repoRoot()                        -- <repo>, cached, from import.meta.url
 *   ConfigError
 *
 * Every knob is optional; the defaults make `TL_ADAPTER=fixture` run end to end
 * with no network and no environment at all.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment variables this module owns. Doctor prints these names in its detail. */
export const ENV_KEYS = {
  adapter: 'TL_ADAPTER',
  now: 'TL_NOW',
  dataDir: 'TL_DATA_DIR',
  tenantDir: 'TL_TENANT_DIR',
  fixturesDir: 'TL_FIXTURES_DIR',
  actor: 'TL_ACTOR',
  lockStaleMs: 'TL_LOCK_STALE_MS',
} as const;

/** Which port implementations the runtime binds. `rippling` is stubs until a tenant exists. */
export const ADAPTER_MODES = ['fixture', 'rippling'] as const;
export type AdapterMode = (typeof ADAPTER_MODES)[number];

/** A per-cycle lock older than this is reclaimable (spec §5, lock row). */
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

/** Directory names, relative to the repo root, used for the defaults. */
const DEFAULT_DATA_DIRNAME = 'data';
const DEFAULT_TENANT_DIRNAME = 'tenant';
const DEFAULT_FIXTURES_DIRNAME = path.join('fixtures', 'tenant');

/** The only error this module throws. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Resolved environment for one process. Treat as immutable. */
export interface Config {
  /** Which adapter family the runtime binds (`TL_ADAPTER`). */
  readonly adapter: AdapterMode;
  /** The instant every tick and record uses as "now". Frozen for the process. */
  readonly now: Date;
  /** True when `now` came from `TL_NOW` rather than the wall clock. */
  readonly nowFrozen: boolean;
  /** Runtime tier-2/3 state and ledger root (`TL_DATA_DIR`), absolute. */
  readonly dataDir: string;
  /** Tenant layer: `policy.yml`, `ledger/` (`TL_TENANT_DIR`), absolute. */
  readonly tenantDir: string;
  /** Read-only tier-1 seed data (`TL_FIXTURES_DIR`), absolute. */
  readonly fixturesDir: string;
  /** Worker id of the acting user (`TL_ACTOR`); unset means "use the default identity". */
  readonly actor?: string;
  /** Lock staleness threshold in ms (`TL_LOCK_STALE_MS`). */
  readonly lockStaleMs: number;
  /** Repository root, resolved from `import.meta.url` — never from the cwd. */
  readonly repoRoot: string;
}

let cachedRepoRoot: string | undefined;

/**
 * Nearest ancestor of this module that holds a `package.json`.
 * Resolved once per process; independent of the current working directory.
 */
export function repoRoot(): string {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, 'package.json'))) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(
    'cannot locate the repository root: no package.json above lib/config.ts. ' +
      'Run the CLIs from a checkout, not a copied file.',
  );
}

/** Trim an env value, treating empty/whitespace-only as unset. */
function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function resolveAdapter(env: NodeJS.ProcessEnv): AdapterMode {
  const raw = read(env, ENV_KEYS.adapter);
  if (raw === undefined) return 'fixture';
  const found = ADAPTER_MODES.find((mode) => mode === raw);
  if (found === undefined) {
    throw new ConfigError(
      `${ENV_KEYS.adapter}="${raw}" is not a known adapter ` +
        `(expected ${ADAPTER_MODES.join(' | ')})`,
    );
  }
  return found;
}

/**
 * Accept an ISO-8601 date or date-time. Deliberately stricter than `Date.parse`,
 * which happily accepts "March 3" and other shapes a fixture anchor must not take.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function resolveNow(env: NodeJS.ProcessEnv): { now: Date; frozen: boolean } {
  const raw = read(env, ENV_KEYS.now);
  if (raw === undefined) return { now: new Date(), frozen: false };
  if (!ISO_INSTANT.test(raw)) {
    throw new ConfigError(
      `${ENV_KEYS.now}="${raw}" is not an ISO-8601 instant ` +
        '(expected e.g. 2026-09-02T16:00:00Z)',
    );
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ConfigError(`${ENV_KEYS.now}="${raw}" is not a valid date`);
  }
  return { now: new Date(ms), frozen: true };
}

function resolveDir(
  env: NodeJS.ProcessEnv,
  key: string,
  fallbackRelative: string,
  root: string,
): string {
  const raw = read(env, key);
  return raw === undefined ? path.join(root, fallbackRelative) : path.resolve(raw);
}

function resolveLockStaleMs(env: NodeJS.ProcessEnv): number {
  const raw = read(env, ENV_KEYS.lockStaleMs);
  if (raw === undefined) return DEFAULT_LOCK_STALE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${ENV_KEYS.lockStaleMs}="${raw}" must be a positive integer number of milliseconds`,
    );
  }
  return value;
}

/**
 * Read and validate the environment.
 * @param env defaults to `process.env`; tests pass an explicit object.
 * @throws ConfigError naming the offending variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = repoRoot();
  const adapter = resolveAdapter(env);
  const clock = resolveNow(env);
  const actor = read(env, ENV_KEYS.actor);

  const base = {
    adapter,
    now: clock.now,
    nowFrozen: clock.frozen,
    dataDir: resolveDir(env, ENV_KEYS.dataDir, DEFAULT_DATA_DIRNAME, root),
    tenantDir: resolveDir(env, ENV_KEYS.tenantDir, DEFAULT_TENANT_DIRNAME, root),
    fixturesDir: resolveDir(env, ENV_KEYS.fixturesDir, DEFAULT_FIXTURES_DIRNAME, root),
    lockStaleMs: resolveLockStaleMs(env),
    repoRoot: root,
  } satisfies Omit<Config, 'actor'>;

  return actor === undefined ? base : { ...base, actor };
}

/**
 * The configured instant, as a fresh `Date` the caller may mutate freely.
 * Always use this instead of `new Date()` so `TL_NOW` really freezes a run.
 */
export function now(config: Config): Date {
  return new Date(config.now.getTime());
}
