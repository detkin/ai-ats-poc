/**
 * CLI tests for `bin/doctor.mjs` (block B0.5).
 *
 * Covers: the exit-code contract (0 healthy, 1 on any failing check or a bad
 * environment, 2 on a bad argument), the `--json` report shape the M0 tester and
 * `--json` consumers depend on, and the human rendering. The CLI is spawned as a
 * real process with an explicit environment so nothing leaks in from the runner.
 *
 * Since block B1.5 the CLI is `runCli(DOCTOR_SPEC, …)` like the other nine, so `--help`
 * is the shared generated help (`Usage:` on its own line above `node bin/doctor.mjs`)
 * rather than a hand-written USAGE string. Every exit code is unchanged.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCTOR = path.join(REPO_ROOT, 'bin', 'doctor.mjs');
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

/** A minimal fixture tenant in plan §2.7 shape (the real one is another block's). */
function makeFixturesDir(): string {
  const dir = makeTempDir('tl-cli-fixtures-');
  const body = JSON.stringify([{ id: 'w_1' }, { id: 'w_2' }], null, 2);
  writeFileSync(path.join(dir, 'workers.json'), body, 'utf8');
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        anchor_now: ANCHOR,
        generator_version: 'test',
        seed: 42,
        files: {
          'workers.json': {
            count: 2,
            sha256: createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

function makeSeededDataDir(): string {
  const dir = makeTempDir('tl-cli-data-');
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runDoctorCli(args: string[], env: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, [DOCTOR, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TL_NOW: ANCHOR,
      ...env,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function healthyEnv(): Record<string, string> {
  return {
    TL_FIXTURES_DIR: makeFixturesDir(),
    TL_TENANT_DIR: REAL_TENANT_DIR,
    TL_DATA_DIR: makeSeededDataDir(),
  };
}

describe('bin/doctor.mjs --json', () => {
  it('exits 0 and prints the documented JSON shape on a healthy checkout', () => {
    const result = runDoctorCli(['--json'], healthyEnv());

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { ok: number; warn: number; fail: number };
      checks: { id: string; status: string; detail: string; fix?: string }[];
    };

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.checks).toHaveLength(9);
    expect(report.checks.map((check) => check.id)).toContain('fixtures_seeded');
    for (const check of report.checks) {
      expect(typeof check.id).toBe('string');
      expect(['ok', 'warn', 'fail']).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
      if (check.status !== 'ok') expect(typeof check.fix).toBe('string');
    }
    // MCP servers are informational until a tenant exists.
    const mcp = report.checks.find((check) => check.id === 'mcp_servers');
    expect(mcp?.status).toBe('warn');
  });

  it('exits 1 when the tenant policy is still the template', () => {
    const tenantDir = makeTempDir('tl-cli-tenant-');
    copyFileSync(
      path.join(REAL_TENANT_DIR, 'policy.template.yml'),
      path.join(tenantDir, 'policy.yml'),
    );
    mkdirSync(path.join(tenantDir, 'ledger'), { recursive: true });

    const result = runDoctorCli(['--json'], { ...healthyEnv(), TL_TENANT_DIR: tenantDir });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { id: string; status: string; fix?: string }[];
    };
    expect(report.ok).toBe(false);
    const policy = report.checks.find((check) => check.id === 'tenant_policy');
    expect(policy?.status).toBe('fail');
    expect(policy?.fix).toContain('policy.template.yml');
  });

  it('exits 1 when the fixtures are not seeded', () => {
    const result = runDoctorCli(['--json'], {
      ...healthyEnv(),
      TL_FIXTURES_DIR: makeTempDir('tl-cli-unseeded-'),
    });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { ok: boolean };
    expect(report.ok).toBe(false);
  });
});

describe('bin/doctor.mjs human output', () => {
  it('prints one symbol-prefixed line per check and a verdict', () => {
    const result = runDoctorCli([], healthyEnv());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Talent Loops doctor');
    expect(result.stdout).toContain('✓ node_version');
    expect(result.stdout).toContain('! mcp_servers');
    expect(result.stdout).toContain('Result: healthy');
  });

  it('shows the fix line for a failing check', () => {
    const result = runDoctorCli([], {
      ...healthyEnv(),
      TL_FIXTURES_DIR: makeTempDir('tl-cli-unseeded-'),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('✗ fixtures_seeded');
    expect(result.stdout).toContain('fix: npm run seed');
    expect(result.stdout).toContain('Result: not ready');
  });
});

describe('bin/doctor.mjs argument and environment errors', () => {
  it('exits 2 on an unknown argument', () => {
    const result = runDoctorCli(['--wat'], healthyEnv());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });

  it('exits 0 and prints usage for --help', () => {
    const result = runDoctorCli(['--help'], healthyEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node bin/doctor.mjs');
    expect(result.stdout).toContain('Exit codes:');
  });

  it('exits 1 with a named variable when the environment is invalid', () => {
    const result = runDoctorCli([], { ...healthyEnv(), TL_ADAPTER: 'greenhouse' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TL_ADAPTER');
  });
});
