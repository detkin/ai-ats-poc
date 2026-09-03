/**
 * tests/cli/bridge.test.ts — `bin/bridge.mjs` fetch-plan / import / status (block B2.6).
 *
 * The bridge CLI is the only seam between an agent-executed MCP read (docs/DECISIONS.md D25)
 * and the scripts, so it has to be exact in two directions: the plan must name every call the
 * agent has to make, and the import must refuse a snapshot it cannot map rather than write a
 * half-tenant. A re-import must also leave a running cycle's state alone.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROVENANCE_FILE, READ_FUNCTIONS } from '#lib/adapters/bridge/index.ts';
import type { Provenance } from '#lib/adapters/bridge/index.ts';
import { BRIDGE_SPEC, runBridge } from '#lib/cli/bridge.ts';
import { runCli, runJson } from '#tests/cli/helpers.ts';
import { SAMPLE_SNAPSHOT_PATH } from '#tests/bridge/helpers.ts';

const NOW = '2026-09-02T16:00:00Z';

let dataDir: string;
const saved = { dataDir: process.env.TL_DATA_DIR, now: process.env.TL_NOW };

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tl-bridge-cli-'));
  process.env.TL_DATA_DIR = dataDir;
  process.env.TL_NOW = NOW;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (saved.dataDir === undefined) delete process.env.TL_DATA_DIR;
  else process.env.TL_DATA_DIR = saved.dataDir;
  if (saved.now === undefined) delete process.env.TL_NOW;
  else process.env.TL_NOW = saved.now;
});

describe('fetch-plan', () => {
  it('exits 0 and names every read function the agent must run', async () => {
    const run = await runCli(BRIDGE_SPEC, runBridge, ['fetch-plan']);
    expect(run.code).toBe(0);
    for (const fn of READ_FUNCTIONS) {
      expect(run.stdout, `fetch-plan does not name codemode.${fn}`).toContain(`codemode.${fn}`);
    }
  });

  it('states the telemetry contract and the org-walk algorithm', async () => {
    const run = await runCli(BRIDGE_SPEC, runBridge, ['fetch-plan']);
    expect(run.stdout).toContain('telemetry: { intent }');
    expect(run.stdout).toContain('lookup_direct_reports');
    expect(run.stdout).toContain('queue');
    // The plan must be honest about what the MCP will not give it.
    expect(run.stdout).toContain('redacted');
  });

  it('has a machine form an agent can drive', async () => {
    const { data } = await runJson<{
      telemetry_required: boolean;
      steps: { fn: string; args: string }[];
      walk: string[];
      file: string;
      file_shape: string[];
    }>(BRIDGE_SPEC, runBridge, ['fetch-plan']);
    expect(data.telemetry_required).toBe(true);
    expect(data.steps.every((step) => step.args.includes('telemetry'))).toBe(true);
    expect(data.walk.length).toBeGreaterThan(3);
    expect(data.file).toContain('snapshot.json');
    expect(data.file_shape.join('\n')).toContain('direct_reports');
  });

  it('makes no network call — nothing is fetched and no tenant appears', async () => {
    const before = existsSync(join(dataDir, 'tier1'));
    await runCli(BRIDGE_SPEC, runBridge, ['fetch-plan']);
    expect(existsSync(join(dataDir, 'tier1'))).toBe(before);
  });
});

describe('status before anything is imported', () => {
  it('exits 1 and points at the import command', async () => {
    const run = await runCli(BRIDGE_SPEC, runBridge, ['status']);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('bin/bridge.mjs import');
  });
});

describe('import', () => {
  it('writes tier1, provenance and an empty runtime state', async () => {
    const { run, data } = await runJson<{
      ok: boolean;
      tier1_dir: string;
      counts: Record<string, number>;
      seeded_state: boolean;
      warnings: string[];
    }>(BRIDGE_SPEC, runBridge, ['import', '--from', SAMPLE_SNAPSHOT_PATH]);
    expect(run.code).toBe(0);
    expect(data.ok).toBe(true);
    expect(data.counts.workers).toBe(8);
    expect(data.seeded_state).toBe(true);
    expect(data.warnings.length).toBeGreaterThan(0);

    const tier1 = join(dataDir, 'tier1');
    for (const file of ['workers.json', 'departments.json', 'locations.json', 'teams.json']) {
      expect(existsSync(join(tier1, file)), `${file} missing`).toBe(true);
    }
    expect(existsSync(join(tier1, 'resumes'))).toBe(true);
    expect(existsSync(join(dataDir, 'state', 'cycles.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'ledger.jsonl'))).toBe(true);

    const provenance = JSON.parse(readFileSync(join(tier1, PROVENANCE_FILE), 'utf8')) as Provenance;
    expect(provenance.source).toBe('rippling-mcp');
    expect(provenance.actor_worker_id).toBe('w_ceo');
  });

  it('does not clobber runtime state on re-import — the user may re-fetch mid-cycle', async () => {
    const cycles = join(dataDir, 'state', 'cycles.json');
    writeFileSync(cycles, JSON.stringify([{ id: 'tl_cycle_keepme' }], null, 2), 'utf8');
    writeFileSync(join(dataDir, 'ledger.jsonl'), '{"id":"keep"}\n', 'utf8');

    const run = await runCli(BRIDGE_SPEC, runBridge, ['import', '--from', SAMPLE_SNAPSHOT_PATH]);
    expect(run.code).toBe(0);
    expect(readFileSync(cycles, 'utf8')).toContain('tl_cycle_keepme');
    expect(readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')).toContain('keep');
    expect(run.stdout).toContain('left the existing runtime state');
  });

  it('exits 1 with named errors on a snapshot that cannot be mapped', async () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'tl-bridge-bad-')), 'snapshot.json');
    const snapshot = JSON.parse(readFileSync(SAMPLE_SNAPSHOT_PATH, 'utf8')) as {
      people: { id: string }[];
      fetched_at: string;
    };
    snapshot.people = snapshot.people.filter((person) => person.id !== 'w_ceo');
    snapshot.fetched_at = 'yesterday';
    writeFileSync(broken, JSON.stringify(snapshot), 'utf8');

    const run = await runCli(BRIDGE_SPEC, runBridge, ['import', '--from', broken]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('fetched_at');
    expect(run.stderr).toContain('is not in the list');
    expect(run.stderr).toContain('bin/bridge.mjs fetch-plan');
  });

  it('exits 1 on a file that is not JSON, and on a file that is not there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-bridge-bad2-'));
    const garbage = join(dir, 'snapshot.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(garbage, 'not json at all', 'utf8');

    const bad = await runCli(BRIDGE_SPEC, runBridge, ['import', '--from', garbage]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('not valid JSON');

    const missing = await runCli(BRIDGE_SPEC, runBridge, [
      'import',
      '--from',
      join(dir, 'nope.json'),
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no snapshot file');
  });

  it('needs --from', async () => {
    const run = await runCli(BRIDGE_SPEC, runBridge, ['import']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--from');
  });
});

describe('status after an import', () => {
  it('reports provenance, counts and freshness', async () => {
    const { run, data } = await runJson<{
      imported: boolean;
      stale: boolean;
      age_hours: number;
      provenance: Provenance;
    }>(BRIDGE_SPEC, runBridge, ['status']);
    expect(run.code).toBe(0);
    expect(data.imported).toBe(true);
    expect(data.stale).toBe(false);
    expect(data.age_hours).toBeCloseTo(0.33, 1);
    expect(data.provenance.counts.workers).toBe(8);
  });

  it('warns when the snapshot is older than the tick interval', async () => {
    process.env.TL_NOW = '2026-09-05T16:00:00Z';
    try {
      const run = await runCli(BRIDGE_SPEC, runBridge, ['status']);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('STALE');
    } finally {
      process.env.TL_NOW = NOW;
    }
  });
});

describe('the CLI contract', () => {
  it('rejects an unknown subcommand and an unknown flag with exit 2', async () => {
    const command = await runCli(BRIDGE_SPEC, runBridge, ['fetch']);
    expect(command.code).toBe(2);
    const flag = await runCli(BRIDGE_SPEC, runBridge, ['status', '--verbose']);
    expect(flag.code).toBe(2);
  });
});
