/**
 * tests/cli/seed.test.ts — block B0.4's CLI, `bin/seed.mjs`.
 *
 * Covers: `--verify` exits 0 on the committed fixtures and 1 on a tampered copy;
 * `--reset` populates a temp `TL_DATA_DIR` with `state/*.json` and an empty
 * `ledger.jsonl`; a fresh `--dir` write round-trips through `--verify`.
 *
 * Spec: docs/PLAN.md §2.8, §2.9 (CLI contract), §3 block B0.4.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { STATE_FILES, defaultFixturesDir } from '#lib/fixtures/index.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const seedCli = join(repoRoot, 'bin', 'seed.mjs');
const committed = defaultFixturesDir();
const temporaries: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

function runSeed(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [seedCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TL_FIXTURES_DIR: '', TL_DATA_DIR: '', ...env },
  });
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('seed.mjs --verify', () => {
  it('exits 0 on the committed fixtures', () => {
    const result = runSeed(['--verify']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('regenerate identically');
  });

  it('exits 1 with a diff summary when a file has been hand-edited', () => {
    const dir = tempDir('tl-seed-verify-');
    cpSync(committed, dir, { recursive: true });
    const path = join(dir, 'workers.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as { title: string }[];
    if (rows[0]) rows[0].title = 'Supreme Commander';
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

    const result = runSeed(['--verify', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('workers.json');
    expect(result.stdout).toContain('npm run seed');
  });

  it('exits 1 when the fixtures directory does not exist', () => {
    const result = runSeed(['--verify', '--dir', join(tmpdir(), 'tl-nope-does-not-exist')]);
    expect(result.status).toBe(1);
  });

  it('reports machine-readable output with --json', () => {
    const result = runSeed(['--verify', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: 'verify' });
  });
});

describe('seed.mjs (no flag)', () => {
  it('writes a fresh tenant that verifies clean', () => {
    const dir = tempDir('tl-seed-write-');
    const write = runSeed(['--dir', dir]);
    expect(write.status).toBe(0);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'resumes', 'cand_0001.md'))).toBe(true);
    expect(runSeed(['--verify', '--dir', dir]).status).toBe(0);
  });
});

describe('seed.mjs --reset', () => {
  it('populates TL_DATA_DIR with the seeded state and an empty ledger', () => {
    const dataDir = tempDir('tl-seed-data-');
    const result = runSeed(['--reset'], { TL_DATA_DIR: dataDir });
    expect(result.status).toBe(0);

    for (const file of Object.values(STATE_FILES)) {
      const name = file.replace('state/', '');
      expect(existsSync(join(dataDir, 'state', name))).toBe(true);
    }
    expect(existsSync(join(dataDir, 'ledger.jsonl'))).toBe(true);
    expect(readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')).toBe('');
    expect(existsSync(join(dataDir, 'state', 'ledger.jsonl'))).toBe(false);

    const cycles = JSON.parse(readFileSync(join(dataDir, 'state', 'cycles.json'), 'utf8')) as {
      id: string;
    }[];
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.id).toBe('tl_cycle_h2_2026');

    const tasks = JSON.parse(readFileSync(join(dataDir, 'state', 'tasks.json'), 'utf8'));
    expect(tasks).toEqual([]);
  });

  it('is idempotent — a second reset restores the same state', () => {
    const dataDir = tempDir('tl-seed-data-');
    runSeed(['--reset'], { TL_DATA_DIR: dataDir });
    writeFileSync(join(dataDir, 'ledger.jsonl'), '{"id":"tl_agent_action_x"}\n', 'utf8');
    expect(runSeed(['--reset'], { TL_DATA_DIR: dataDir }).status).toBe(0);
    expect(readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')).toBe('');
  });
});

describe('seed.mjs argument handling', () => {
  it('prints usage for --help and exits 0', () => {
    const result = runSeed(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--verify');
    expect(result.stdout).toContain('--reset');
  });

  it('rejects an unknown flag', () => {
    const result = runSeed(['--nope']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });
});
