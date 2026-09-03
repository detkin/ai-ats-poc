/**
 * Tests for the cold-start doctor (block B0.5).
 *
 * Covers: a healthy report over a temp fixture tenant plus the committed tenant
 * policy; the four fixture-integrity failures (missing manifest, missing file,
 * sha256 mismatch, record-count mismatch); the template policy refusal; MCP being
 * `warn` and never `fail` in fixture mode; runtime state being `warn` when nothing
 * has been seeded; and `report.ok` being false exactly when something fails.
 *
 * The fixture tenant itself is written by another block, so these tests build their
 * own tiny manifest + files in a temp dir and point `TL_FIXTURES_DIR` at it.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '#lib/config.ts';
import { loadConfig } from '#lib/config.ts';
import type { Check, CheckStatus } from '#lib/doctor/index.ts';
import { checkMcpServers, runDoctor } from '#lib/doctor/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_TENANT_DIR = path.join(REPO_ROOT, 'tenant');
const ANCHOR = '2026-09-02T16:00:00Z';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** A minimal fixture tenant: two JSON arrays and a manifest in plan §2.7 shape. */
function makeFixturesDir(): { dir: string; files: Record<string, string> } {
  const dir = makeTempDir('tl-doctor-fixtures-');
  const files: Record<string, string> = {
    'workers.json': JSON.stringify([{ id: 'w_1' }, { id: 'w_2' }, { id: 'w_3' }], null, 2),
    'departments.json': JSON.stringify([{ id: 'dept_1' }], null, 2),
  };
  const manifestFiles: Record<string, { count: number; sha256: string }> = {};
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body, 'utf8');
    manifestFiles[name] = {
      count: (JSON.parse(body) as unknown[]).length,
      sha256: sha256(body),
    };
  }
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      { anchor_now: ANCHOR, generator_version: 'test', seed: 42, files: manifestFiles },
      null,
      2,
    ),
    'utf8',
  );
  return { dir, files };
}

/** A data dir whose `state/` subdirectory exists, as `seed --reset` would leave it. */
function makeSeededDataDir(): string {
  const dir = makeTempDir('tl-doctor-data-');
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

/** A tenant dir holding the given policy file plus the `ledger/` write target. */
function makeTenantDir(policySource: string): string {
  const dir = makeTempDir('tl-doctor-tenant-');
  copyFileSync(policySource, path.join(dir, 'policy.yml'));
  mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  return dir;
}

function configWith(overrides: NodeJS.ProcessEnv): Config {
  return loadConfig({ TL_NOW: ANCHOR, ...overrides });
}

function byId(checks: readonly Check[], id: string): Check {
  const found = checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check "${id}" in report`);
  return found;
}

function statusOf(checks: readonly Check[], id: string): CheckStatus {
  return byId(checks, id).status;
}

describe('runDoctor — healthy checkout', () => {
  it('reports ok overall with intact fixtures, a real policy and seeded state', async () => {
    const fixtures = makeFixturesDir();
    const config = configWith({
      TL_FIXTURES_DIR: fixtures.dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });

    const report = await runDoctor(config);

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.checks).toHaveLength(10);
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(10);
    expect(statusOf(report.checks, 'node_version')).toBe('ok');
    expect(statusOf(report.checks, 'adapter_mode')).toBe('ok');
    expect(statusOf(report.checks, 'clock')).toBe('ok');
    expect(statusOf(report.checks, 'tenant_policy')).toBe('ok');
    expect(statusOf(report.checks, 'loop_states')).toBe('ok');
    expect(statusOf(report.checks, 'fixtures_seeded')).toBe('ok');
    expect(statusOf(report.checks, 'runtime_state')).toBe('ok');
    expect(statusOf(report.checks, 'tier1_snapshot')).toBe('ok');
    expect(statusOf(report.checks, 'write_dirs')).toBe('ok');
    expect(byId(report.checks, 'tenant_policy').detail).toContain('Acme Robotics');
    expect(byId(report.checks, 'clock').detail).toContain(ANCHOR.replace('Z', '.000Z'));
  });

  it('reports every check in the documented order', async () => {
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });
    const report = await runDoctor(config);
    expect(report.checks.map((check) => check.id)).toEqual([
      'node_version',
      'adapter_mode',
      'clock',
      'tenant_policy',
      'loop_states',
      'fixtures_seeded',
      'runtime_state',
      'tier1_snapshot',
      'mcp_servers',
      'write_dirs',
    ]);
  });
});

describe('tenant policy check', () => {
  it('fails when policy.yml is still the shipped template', async () => {
    const tenantDir = makeTenantDir(path.join(REAL_TENANT_DIR, 'policy.template.yml'));
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: tenantDir,
      TL_DATA_DIR: makeSeededDataDir(),
    });

    const report = await runDoctor(config);
    const check = byId(report.checks, 'tenant_policy');

    expect(report.ok).toBe(false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('template');
    expect(check.fix).toContain('policy.template.yml');
  });

  it('passes when the same temp tenant holds the personalized policy', async () => {
    const tenantDir = makeTenantDir(path.join(REAL_TENANT_DIR, 'policy.yml'));
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: tenantDir,
      TL_DATA_DIR: makeSeededDataDir(),
    });

    const report = await runDoctor(config);
    expect(statusOf(report.checks, 'tenant_policy')).toBe('ok');
    expect(report.ok).toBe(true);
  });

  it('fails with a copy-the-template fix when policy.yml is absent', async () => {
    const tenantDir = makeTempDir('tl-doctor-empty-tenant-');
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: tenantDir,
      TL_DATA_DIR: makeSeededDataDir(),
    });

    const check = byId((await runDoctor(config)).checks, 'tenant_policy');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('policy.template.yml');
  });
});

describe('fixtures_seeded check', () => {
  async function fixturesCheck(fixturesDir: string): Promise<Check> {
    const config = configWith({
      TL_FIXTURES_DIR: fixturesDir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });
    return byId((await runDoctor(config)).checks, 'fixtures_seeded');
  }

  it('fails with "npm run seed" when the manifest is missing', async () => {
    const check = await fixturesCheck(makeTempDir('tl-doctor-unseeded-'));
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('npm run seed');
  });

  it('fails and names the file when a sha256 mismatches', async () => {
    const fixtures = makeFixturesDir();
    writeFileSync(
      path.join(fixtures.dir, 'workers.json'),
      JSON.stringify([{ id: 'w_1' }, { id: 'w_2' }, { id: 'w_TAMPERED' }], null, 2),
      'utf8',
    );

    const check = await fixturesCheck(fixtures.dir);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('workers.json');
    expect(check.detail).toContain('sha256 mismatch');
  });

  it('fails and names the file when a listed file is missing', async () => {
    const fixtures = makeFixturesDir();
    rmSync(path.join(fixtures.dir, 'departments.json'));

    const check = await fixturesCheck(fixtures.dir);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('departments.json');
    expect(check.detail).toContain('missing');
  });

  it('fails when the record count disagrees with the manifest', async () => {
    const fixtures = makeFixturesDir();
    const body = JSON.stringify([{ id: 'w_1' }, { id: 'w_2' }], null, 2);
    writeFileSync(path.join(fixtures.dir, 'workers.json'), body, 'utf8');
    // Keep the hash honest so only the count can be the complaint.
    const manifest = {
      anchor_now: ANCHOR,
      generator_version: 'test',
      seed: 42,
      files: {
        'workers.json': { count: 3, sha256: sha256(body) },
      },
    };
    writeFileSync(
      path.join(fixtures.dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    const check = await fixturesCheck(fixtures.dir);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('manifest says 3 records, file holds 2');
  });
});

describe('runtime_state check', () => {
  it('warns, never fails, when the data dir has not been seeded', async () => {
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: path.join(makeTempDir('tl-doctor-nodata-'), 'never-created'),
    });

    const report = await runDoctor(config);
    const check = byId(report.checks, 'runtime_state');
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('seed.mjs --reset');
    expect(report.ok).toBe(true);
  });
});

describe('mcp_servers check', () => {
  it('warns rather than fails in fixture mode, and says the demo needs none of them', async () => {
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });

    const report = await runDoctor(config);
    const check = byId(report.checks, 'mcp_servers');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('rippling');
    expect(check.fix).toContain('connect when a tenant exists');
    expect(report.ok).toBe(true);
  });

  it('still only warns in fixture mode when .mcp.json is absent entirely', async () => {
    const config = configWith({ TL_FIXTURES_DIR: makeFixturesDir().dir });
    const check = await checkMcpServers({
      ...config,
      repoRoot: makeTempDir('tl-doctor-norepo-'),
    });
    expect(check.status).toBe('warn');
  });

  /**
   * The committed `.mcp.json` gained a real Rippling gateway URL in M2.5, so this now takes
   * the `warn` branch: Rippling is connected, Slack and Google Calendar are still
   * placeholders. The `fail` branch is asserted below against a synthetic config.
   */
  it('warns in rippling mode when rippling is connected but the others are placeholders', async () => {
    const config = configWith({ TL_ADAPTER: 'rippling' });
    const check = await checkMcpServers(config);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('configured: rippling');
    expect(check.detail).toContain('placeholder: slack, google-calendar');
  });

  it('fails outside fixture mode when the rippling entry itself is a placeholder', async () => {
    const repoRoot = makeTempDir('tl-doctor-mcp-');
    writeFileSync(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          rippling: { type: 'http', url: 'https://example.invalid/mcp', _placeholder: true },
          slack: { type: 'http', url: 'https://example.invalid/mcp', _placeholder: true },
          'google-calendar': {
            type: 'http',
            url: 'https://example.invalid/mcp',
            _placeholder: true,
          },
        },
      }),
      'utf8',
    );
    for (const adapter of ['rippling', 'bridge'] as const) {
      const check = await checkMcpServers({ ...configWith({ TL_ADAPTER: adapter }), repoRoot });
      expect(check.status, `${adapter} should fail on a placeholder rippling entry`).toBe('fail');
      expect(check.detail).toContain('placeholder');
    }
  });
});

describe('adapter_mode check', () => {
  it('warns that rippling adapters are stubs until a tenant is connected', async () => {
    const config = configWith({
      TL_ADAPTER: 'rippling',
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });

    const check = byId((await runDoctor(config)).checks, 'adapter_mode');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('stubs only until a tenant is connected');
  });
});

/**
 * `tier1_snapshot` (block B2.6). On `bridge` the imported tenant *is* the run's data, so a
 * missing one is fatal and a stale one silently ticks yesterday's org chart. In every other
 * mode it is `ok` + "n/a", which keeps the report the same shape everywhere.
 */
describe('tier1_snapshot check', () => {
  /** A data dir holding a bridged tenant's provenance file, dated `fetchedAt`. */
  function makeBridgedDataDir(fetchedAt: string): string {
    const dir = makeSeededDataDir();
    mkdirSync(path.join(dir, 'tier1'), { recursive: true });
    writeFileSync(
      path.join(dir, 'tier1', 'provenance.json'),
      JSON.stringify({
        source: 'rippling-mcp',
        fetched_at: fetchedAt,
        actor_worker_id: 'w_ceo',
        company_id: 'co_test_1',
        counts: { workers: 8, departments: 4 },
        calls: [],
        mapping_version: '1',
        warnings: [],
      }),
      'utf8',
    );
    return dir;
  }

  it('is n/a and ok in fixture mode', async () => {
    const config = configWith({
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });
    const check = byId((await runDoctor(config)).checks, 'tier1_snapshot');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('n/a');
  });

  it('fails in bridge mode with nothing imported, and names the import command', async () => {
    const config = configWith({
      TL_ADAPTER: 'bridge',
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeSeededDataDir(),
    });
    const report = await runDoctor(config);
    const check = byId(report.checks, 'tier1_snapshot');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('bin/bridge.mjs import');
    expect(report.ok).toBe(false);
  });

  it('is ok, with counts, on a freshly imported tenant', async () => {
    const config = configWith({
      TL_ADAPTER: 'bridge',
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeBridgedDataDir('2026-09-02T15:40:00Z'),
    });
    const check = byId((await runDoctor(config)).checks, 'tier1_snapshot');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('workers 8');
    expect(check.detail).toContain('rippling-mcp');
  });

  it('warns once the snapshot is older than cadence.tick_interval_hours', async () => {
    const config = configWith({
      TL_ADAPTER: 'bridge',
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeBridgedDataDir('2026-08-29T16:00:00Z'),
    });
    const report = await runDoctor(config);
    const check = byId(report.checks, 'tier1_snapshot');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('tick_interval_hours');
    // A stale snapshot is a warning, not a refusal: the operator decides.
    expect(report.ok).toBe(true);
  });

  it('reports bridge mode as a healthy adapter, not a stub', async () => {
    const config = configWith({
      TL_ADAPTER: 'bridge',
      TL_FIXTURES_DIR: makeFixturesDir().dir,
      TL_TENANT_DIR: REAL_TENANT_DIR,
      TL_DATA_DIR: makeBridgedDataDir('2026-09-02T15:40:00Z'),
    });
    const check = byId((await runDoctor(config)).checks, 'adapter_mode');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('imported');
  });
});
