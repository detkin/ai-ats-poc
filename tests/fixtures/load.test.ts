/**
 * tests/fixtures/load.test.ts — block B0.4's loader and manifest check.
 *
 * Covers: the committed fixtures load and equal a fresh generation; `verifyManifest` is
 * clean on them; a corrupted copy fails and names the file; a dangling foreign key throws
 * `FixtureError`; `TL_FIXTURES_DIR` is honoured and read at call time.
 *
 * Spec: docs/PLAN.md §2.7, §3 block B0.4.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTenant } from '#lib/fixtures/generate.ts';
import {
  FixtureError,
  defaultFixturesDir,
  loadTenant,
  readManifest,
  resolveFixturesDir,
  verifyManifest,
} from '#lib/fixtures/load.ts';

const committed = defaultFixturesDir();
const temporaries: string[] = [];

function copyFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tl-fixtures-'));
  cpSync(committed, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.TL_FIXTURES_DIR;
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadTenant on the committed fixtures', () => {
  it('loads and equals a fresh generation from the manifest seed', () => {
    const manifest = readManifest(committed);
    expect(loadTenant(committed)).toEqual(generateTenant(manifest.seed));
  });

  it('reports a clean manifest', () => {
    expect(verifyManifest(committed)).toEqual({ ok: true, problems: [] });
  });

  it('lists every file the tenant contains in the manifest', () => {
    const manifest = readManifest(committed);
    const files = Object.keys(manifest.files);
    expect(files).toContain('workers.json');
    expect(files).toContain('calendar_busy.json');
    expect(files).toContain('state/cycles.json');
    expect(files).toContain('state/ledger.jsonl');
    expect(files.filter((file) => file.startsWith('resumes/'))).toHaveLength(40);
    expect(manifest.files['workers.json']?.count).toBe(120);
    expect(manifest.files['state/ledger.jsonl']?.count).toBe(0);
    expect(manifest.anchor_now).toBe('2026-09-02T16:00:00Z');
  });
});

describe('directory resolution', () => {
  it('prefers the argument, then TL_FIXTURES_DIR, then the repo default', () => {
    expect(resolveFixturesDir('/somewhere/else')).toBe('/somewhere/else');
    process.env.TL_FIXTURES_DIR = '/from/env';
    expect(resolveFixturesDir()).toBe('/from/env');
    delete process.env.TL_FIXTURES_DIR;
    expect(resolveFixturesDir()).toBe(committed);
  });

  it('reads TL_FIXTURES_DIR at call time, not at import time', () => {
    const dir = copyFixtures();
    process.env.TL_FIXTURES_DIR = dir;
    expect(loadTenant().workers).toHaveLength(120);
    expect(verifyManifest().ok).toBe(true);
  });
});

describe('a corrupted copy', () => {
  it('fails to load and names the file', () => {
    const dir = copyFixtures();
    writeFileSync(join(dir, 'workers.json'), '{ not json', 'utf8');
    expect(() => loadTenant(dir)).toThrow(FixtureError);
    try {
      loadTenant(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureError);
      const problems = (error as FixtureError).problems;
      expect(problems.some((problem) => problem.startsWith('workers.json:'))).toBe(true);
    }
  });

  it('fails the manifest check with a sha256 mismatch naming the file', () => {
    const dir = copyFixtures();
    const path = join(dir, 'candidates.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as { first_name: string }[];
    if (rows[0]) rows[0].first_name = 'Tampered';
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    const result = verifyManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('candidates.json: sha256 mismatch');
  });

  it('flags a file that is on disk but not in the manifest', () => {
    const dir = copyFixtures();
    writeFileSync(join(dir, 'resumes', 'cand_9999.md'), '# Stray\n', 'utf8');
    const result = verifyManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('resumes/cand_9999.md: present on disk');
  });

  it('flags a file the manifest lists but that is missing', () => {
    const dir = copyFixtures();
    rmSync(join(dir, 'holidays.json'));
    const result = verifyManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('holidays.json: listed in the manifest');
  });
});

describe('a dangling foreign key', () => {
  it('throws FixtureError naming the row and the missing target', () => {
    const dir = copyFixtures();
    const path = join(dir, 'applications.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as { id: string; job_id: string }[];
    if (rows[0]) rows[0].job_id = 'req_does_not_exist';
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

    let caught: unknown;
    try {
      loadTenant(dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FixtureError);
    const problems = (caught as FixtureError).problems;
    expect(problems.join('\n')).toContain('req_does_not_exist');
    expect(problems.join('\n')).toContain('applications.json');
  });

  it('collects every problem rather than stopping at the first', () => {
    const dir = copyFixtures();
    const path = join(dir, 'absences.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as { worker_id: string }[];
    for (const row of rows) row.worker_id = 'w_9999';
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

    let caught: unknown;
    try {
      loadTenant(dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FixtureError);
    expect((caught as FixtureError).problems.length).toBeGreaterThan(1);
    expect((caught as FixtureError).message).toContain('npm run seed');
  });

  it('rejects a second default identity', () => {
    const dir = copyFixtures();
    const path = join(dir, 'identities.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as { is_default: boolean }[];
    for (const row of rows) row.is_default = true;
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    expect(() => loadTenant(dir)).toThrow(/exactly one is_default/);
  });
});

describe('a missing directory', () => {
  it('throws FixtureError rather than returning an empty tenant', () => {
    expect(() => loadTenant('/definitely/not/a/fixtures/dir')).toThrow(FixtureError);
  });
});
