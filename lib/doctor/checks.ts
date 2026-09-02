/**
 * lib/doctor/checks.ts — the individual cold-start checks (block B0.5).
 *
 * Owns: one async function per question `bin/doctor.mjs` answers — can this
 * checkout run a tick at all? Each check reads the filesystem and the already
 * validated contracts (`lib/policy`, `lib/states`); none of them writes anything,
 * and none of them throws: a broken input is a `fail` with a `fix` string, so the
 * report always renders in full. Spec §5 (`doctor.mjs` row: MCP connected? adapter
 * mode? tenant policy still a template? fixtures seeded?), §11; plan §2.5–2.7.
 *
 * Public interface:
 *   CHECK_STATUSES, CheckStatus      -- 'ok' | 'warn' | 'fail'
 *   Check, CheckFn                   -- { id, status, detail, fix? }
 *   CHECK_IDS                        -- the ids, in report order
 *   CHECKS                           -- the ordered check functions
 *   EXPECTED_MCP_SERVERS, MCP_CONFIG_FILENAME
 *   checkNodeVersion, checkAdapterMode, checkClock, checkTenantPolicy,
 *   checkLoopStates, checkFixturesSeeded, checkRuntimeState, checkMcpServers,
 *   checkWriteDirs
 *
 * Severity rule: `fail` means a tick would be wrong or impossible (template policy,
 * corrupt fixtures, unreadable states contract). `warn` means a demo path is not
 * wired yet (no MCP connected in fixture mode, runtime state not seeded).
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '#lib/config.ts';
import { ENV_KEYS } from '#lib/config.ts';
import { isTemplatePolicy, loadPolicy, POLICY_FILENAME, PolicyError } from '#lib/policy/index.ts';
import { loadLoopStates, LoopStatesError, MACHINE_NAMES } from '#lib/states/index.ts';

export const CHECK_STATUSES = ['ok', 'warn', 'fail'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** One answered question. `fix` is a copy-pasteable next step, present when not `ok`. */
export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export type CheckFn = (config: Config) => Promise<Check>;

/** Minimum Node major version (native TypeScript stripping; DECISIONS D1). */
const MIN_NODE_MAJOR = 24;

/** MCP servers the demo expects to see declared. */
export const EXPECTED_MCP_SERVERS = ['rippling', 'slack', 'google-calendar'] as const;
export const MCP_CONFIG_FILENAME = '.mcp.json';

/** Fixture manifest shape (plan §2.7). */
const MANIFEST_FILENAME = 'manifest.json';

function ok(id: string, detail: string): Check {
  return { id, status: 'ok', detail };
}

function warn(id: string, detail: string, fix: string): Check {
  return { id, status: 'warn', detail, fix };
}

function fail(id: string, detail: string, fix: string): Check {
  return { id, status: 'fail', detail, fix };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ checks */

/** Node 24+ is required: `bin/*.mjs` import `.ts` directly with no build step. */
export async function checkNodeVersion(_config: Config): Promise<Check> {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return fail(
      'node_version',
      `Node v${version} is too old; the CLIs import TypeScript directly (needs >= ${MIN_NODE_MAJOR})`,
      `install Node ${MIN_NODE_MAJOR} or newer (nvm install ${MIN_NODE_MAJOR})`,
    );
  }
  return ok('node_version', `Node v${version} (>= ${MIN_NODE_MAJOR})`);
}

/** Which port family the runtime would bind. `rippling` is stubs until a tenant exists. */
export async function checkAdapterMode(config: Config): Promise<Check> {
  if (config.adapter === 'fixture') {
    return ok('adapter_mode', `fixture adapters (${ENV_KEYS.adapter}=fixture) — no network needed`);
  }
  return warn(
    'adapter_mode',
    `${ENV_KEYS.adapter}=rippling: stubs only until a tenant is connected`,
    `unset ${ENV_KEYS.adapter} to run on fixtures, or connect the Rippling MCP (docs/QUESTIONS.md Q2)`,
  );
}

/** The clock a tick would use. Never fails: a wall clock is valid, just not reproducible. */
export async function checkClock(config: Config): Promise<Check> {
  const iso = config.now.toISOString();
  const detail = config.nowFrozen
    ? `frozen at ${iso} via ${ENV_KEYS.now}`
    : `wall clock, currently ${iso} (set ${ENV_KEYS.now} to freeze it for reproducible runs)`;
  return ok('clock', detail);
}

/** The tenant policy must exist, validate, and no longer be the shipped template. */
export async function checkTenantPolicy(config: Config): Promise<Check> {
  const file = path.join(config.tenantDir, POLICY_FILENAME);
  let policy;
  try {
    policy = loadPolicy(file);
  } catch (cause) {
    if (cause instanceof PolicyError && cause.errors.length > 0) {
      return fail(
        'tenant_policy',
        `${file} is not a valid tenant policy: ${cause.errors.join('; ')}`,
        `fix the keys named above in ${file}`,
      );
    }
    return fail(
      'tenant_policy',
      `cannot load ${file}: ${message(cause)}`,
      'copy policy.template.yml to policy.yml and personalize',
    );
  }

  if (isTemplatePolicy(policy)) {
    return fail(
      'tenant_policy',
      `${file} is still the unpersonalized template (template: true) — refusing to tick on a stranger's cadence`,
      'copy policy.template.yml to policy.yml and personalize',
    );
  }

  return ok(
    'tenant_policy',
    `${policy.tenant.name} — personalized policy at ${file} ` +
      `(max_attempts ${policy.cadence.max_attempts}, escalate to ${policy.escalation.escalate_to})`,
  );
}

/** The state machines every write is validated against (`templates/loop-states.yml`). */
export async function checkLoopStates(_config: Config): Promise<Check> {
  try {
    const states = loadLoopStates();
    const counts = MACHINE_NAMES.map(
      (name) => `${name} ${Object.keys(states.machines[name].states).length}`,
    ).join(', ');
    return ok('loop_states', `contract v${states.version} valid at ${states.source} (${counts})`);
  } catch (cause) {
    const detail = cause instanceof LoopStatesError ? cause.message : message(cause);
    return fail(
      'loop_states',
      `loop-states contract is invalid: ${detail}`,
      'repair templates/loop-states.yml (see lib/states/loop-states.ts for the rules)',
    );
  }
}

interface ManifestEntry {
  count?: number;
  sha256?: string;
}

/**
 * Fixtures are the tier-1 seed. Every file the manifest names must exist, hash to the
 * recorded sha256, and — when it is a JSON array — hold the recorded number of records.
 */
export async function checkFixturesSeeded(config: Config): Promise<Check> {
  const manifestPath = path.join(config.fixturesDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return fail(
      'fixtures_seeded',
      `no fixture manifest at ${manifestPath} — the fixture tenant is not generated`,
      'npm run seed',
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (cause) {
    return fail(
      'fixtures_seeded',
      `${manifestPath} is not valid JSON: ${message(cause)}`,
      'npm run seed',
    );
  }
  if (!isRecord(manifest) || !isRecord(manifest.files)) {
    return fail(
      'fixtures_seeded',
      `${manifestPath} has no "files" map (expected { anchor_now, generator_version, seed, files })`,
      'npm run seed',
    );
  }

  const entries = Object.entries(manifest.files);
  if (entries.length === 0) {
    return fail('fixtures_seeded', `${manifestPath} lists no files`, 'npm run seed');
  }

  const problems: string[] = [];
  let records = 0;
  for (const [relative, rawEntry] of entries) {
    const target = path.join(config.fixturesDir, relative);
    const entry: ManifestEntry = isRecord(rawEntry) ? (rawEntry as ManifestEntry) : {};
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      problems.push(`${relative}: listed in the manifest but missing`);
      continue;
    }
    if (typeof entry.sha256 === 'string') {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== entry.sha256) {
        problems.push(
          `${relative}: sha256 mismatch (manifest ${entry.sha256.slice(0, 12)}…, on disk ${actual.slice(0, 12)}…)`,
        );
        continue;
      }
    }
    if (typeof entry.count === 'number' && relative.endsWith('.json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch (cause) {
        problems.push(`${relative}: not valid JSON (${message(cause)})`);
        continue;
      }
      if (Array.isArray(parsed)) {
        if (parsed.length !== entry.count) {
          problems.push(
            `${relative}: manifest says ${entry.count} records, file holds ${parsed.length}`,
          );
          continue;
        }
        records += parsed.length;
      }
    }
  }

  if (problems.length > 0) {
    return fail(
      'fixtures_seeded',
      `fixture tenant does not match ${manifestPath}: ${problems.join('; ')}`,
      'npm run seed  # regenerate, or restore the files from git',
    );
  }

  const anchor = typeof manifest.anchor_now === 'string' ? manifest.anchor_now : 'unknown anchor';
  return ok(
    'fixtures_seeded',
    `${entries.length} fixture files intact in ${config.fixturesDir} ` +
      `(${records} records, anchor ${anchor})`,
  );
}

/** Runtime tier-2/3 state. Missing is a warn: `seed --reset` creates it, no data is lost. */
export async function checkRuntimeState(config: Config): Promise<Check> {
  const stateDir = path.join(config.dataDir, 'state');
  if (await isDirectory(stateDir)) {
    return ok('runtime_state', `runtime state initialized at ${stateDir}`);
  }
  return warn(
    'runtime_state',
    `no runtime state at ${stateDir} — nothing has been seeded into ${ENV_KEYS.dataDir} yet`,
    'node bin/seed.mjs --reset',
  );
}

/**
 * MCP servers are informational in fixture mode: the demo never calls them. In
 * `rippling` mode a missing or placeholder `rippling` entry is fatal, because the
 * adapters would have nowhere to call.
 */
export async function checkMcpServers(config: Config): Promise<Check> {
  const file = path.join(config.repoRoot, MCP_CONFIG_FILENAME);
  const fixtureMode = config.adapter === 'fixture';
  const missingFix = `create ${MCP_CONFIG_FILENAME} with rippling, slack and google-calendar entries`;

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    const detail = `no ${MCP_CONFIG_FILENAME} at ${file}`;
    return fixtureMode
      ? warn('mcp_servers', `${detail} — not needed in fixture mode`, missingFix)
      : fail('mcp_servers', detail, missingFix);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const detail = `${file} is not valid JSON: ${message(cause)}`;
    return fixtureMode
      ? warn('mcp_servers', `${detail} — ignored in fixture mode`, `repair ${file}`)
      : fail('mcp_servers', detail, `repair ${file}`);
  }

  const servers =
    isRecord(parsed) && isRecord(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};

  const missing: string[] = [];
  const placeholder: string[] = [];
  const connected: string[] = [];
  for (const name of EXPECTED_MCP_SERVERS) {
    const entry = servers[name];
    if (!isRecord(entry)) {
      missing.push(name);
      continue;
    }
    const hasEndpoint =
      (typeof entry.url === 'string' && entry.url.trim() !== '') ||
      (typeof entry.command === 'string' && entry.command.trim() !== '');
    if (entry._placeholder === true || !hasEndpoint) {
      placeholder.push(name);
      continue;
    }
    connected.push(name);
  }

  if (!fixtureMode && (missing.includes('rippling') || placeholder.includes('rippling'))) {
    return fail(
      'mcp_servers',
      `${ENV_KEYS.adapter}=rippling but the "rippling" server in ${file} is ` +
        `${missing.includes('rippling') ? 'missing' : 'a placeholder'}`,
      'ask the tenant admin for the Rippling MCP URL and an access assignment (docs/QUESTIONS.md Q2)',
    );
  }

  if (missing.length === 0 && placeholder.length === 0) {
    return ok('mcp_servers', `configured: ${connected.join(', ')}`);
  }

  const parts: string[] = [];
  if (connected.length > 0) parts.push(`configured: ${connected.join(', ')}`);
  if (placeholder.length > 0) parts.push(`placeholder: ${placeholder.join(', ')}`);
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  return warn(
    'mcp_servers',
    `${parts.join('; ')} — informational in fixture mode, the demo calls none of them`,
    `connect when a tenant exists; replace the placeholder URLs in ${MCP_CONFIG_FILENAME}`,
  );
}

/** The two directories the engine writes outside `TL_DATA_DIR`. */
export async function checkWriteDirs(config: Config): Promise<Check> {
  const targets: { label: string; dir: string }[] = [
    { label: 'staging/', dir: path.join(config.repoRoot, 'staging') },
    { label: 'tenant/ledger/', dir: path.join(config.tenantDir, 'ledger') },
  ];

  const problems: string[] = [];
  for (const { label, dir } of targets) {
    if (!(await isDirectory(dir))) {
      problems.push(`${label} is missing (${dir})`);
      continue;
    }
    if (!(await isWritable(dir))) {
      problems.push(`${label} is not writable (${dir})`);
    }
  }

  if (problems.length > 0) {
    return fail(
      'write_dirs',
      problems.join('; '),
      `mkdir -p ${targets.map((t) => t.dir).join(' ')} && chmod u+w ${targets.map((t) => t.dir).join(' ')}`,
    );
  }
  return ok('write_dirs', `${targets.map((t) => t.label).join(' and ')} exist and are writable`);
}

/** Report order. `bin/doctor.mjs` prints them in exactly this sequence. */
export const CHECK_IDS = [
  'node_version',
  'adapter_mode',
  'clock',
  'tenant_policy',
  'loop_states',
  'fixtures_seeded',
  'runtime_state',
  'mcp_servers',
  'write_dirs',
] as const;

export const CHECKS: readonly CheckFn[] = [
  checkNodeVersion,
  checkAdapterMode,
  checkClock,
  checkTenantPolicy,
  checkLoopStates,
  checkFixturesSeeded,
  checkRuntimeState,
  checkMcpServers,
  checkWriteDirs,
];
