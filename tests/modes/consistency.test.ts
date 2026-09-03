/**
 * Consistency tests for the operator layer (block B1.4).
 *
 * The modes and the router skill are prose that tells an LLM which scripts to run. Prose
 * rots: a flag gets renamed, a policy value changes, a CLI is dropped. These tests make the
 * markdown fail the build instead of failing a demo.
 *
 * Rows (docs/PLAN.md §4 block B1.4):
 *   a. SKILL.md exists, declares `name: talent-loops`, and stays under 60 lines.
 *   b. every `bin/<x>.mjs` named anywhere in the operator layer exists on disk, and both
 *      shipped loops have a mode file the router can resolve.
 *   c. every `--flag` on a `node bin/<x>.mjs …` command line appears in that CLI's `--help`.
 *   d. every backticked `key.path: value` in `_tenant.md` matches `loadPolicy()`, and every
 *      leaf key of the policy is mentioned at least once.
 *   e. `_shared.md` carries the safety rules it is the system layer for.
 *   f. no mode hard-codes an absolute path or reaches outside the repo.
 *
 * Spec: docs/SPEC.md §5, §9; docs/PLAN.md §2.6, §2.9.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPolicy, POLICY_TOP_LEVEL_KEYS } from '#lib/policy/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODES_DIR = path.join(REPO_ROOT, 'modes');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'talent-loops', 'SKILL.md');
const SKILL_MAX_LINES = 60;

/** One markdown file of the operator layer, read once. */
interface OperatorDoc {
  /** Repo-relative path, used in failure messages. */
  name: string;
  text: string;
}

function readDocs(): OperatorDoc[] {
  const docs: OperatorDoc[] = [
    { name: path.relative(REPO_ROOT, SKILL_PATH), text: readFileSync(SKILL_PATH, 'utf8') },
  ];
  for (const entry of readdirSync(MODES_DIR).sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = path.join(MODES_DIR, entry);
    docs.push({ name: path.relative(REPO_ROOT, file), text: readFileSync(file, 'utf8') });
  }
  return docs;
}

const DOCS = readDocs();

/** Shell line continuations are joined so a wrapped command is scanned as one line. */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, ' ');
}

/** Every `bin/<x>.mjs` named anywhere in a doc (prose or code). */
function binScriptsIn(text: string): string[] {
  return [...text.matchAll(/\bbin\/([a-z][a-z0-9-]*)\.mjs/g)].map((m) => m[1] ?? '');
}

/** A `node bin/<x>.mjs …` invocation and the `--flags` it passes. */
interface CommandUse {
  script: string;
  flags: string[];
  line: string;
}

function commandUsesIn(text: string): CommandUse[] {
  const uses: CommandUse[] = [];
  for (const line of joinContinuations(text).split('\n')) {
    for (const match of line.matchAll(/node bin\/([a-z][a-z0-9-]*)\.mjs(.*)$/g)) {
      const flags = [...(match[2] ?? '').matchAll(/--[a-z][a-z0-9-]*/g)].map((f) => f[0]);
      uses.push({ script: match[1] ?? '', flags, line: line.trim() });
    }
  }
  return uses;
}

/** `node bin/<x>.mjs --help`, stdout + stderr, whatever the exit code. */
function helpText(script: string): string {
  const result = spawnSync(process.execPath, [path.join('bin', `${script}.mjs`), '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/** Every leaf path of a plain object, dot-joined. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix === '' ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function valueAt(root: unknown, dotted: string): unknown {
  let cursor: unknown = root;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Markdown writes policy values unquoted; turn one back into its YAML scalar. */
function coerceScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim().replace(/^['"]/, '').replace(/['"]$/, '');
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

describe('a. the router skill', () => {
  it('exists, is named talent-loops, and stays under the line budget', () => {
    expect(existsSync(SKILL_PATH), `${SKILL_PATH} is missing`).toBe(true);
    const text = readFileSync(SKILL_PATH, 'utf8');

    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    expect(frontmatter, 'SKILL.md must open with a YAML frontmatter block').not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^name: talent-loops$/m);
    expect(frontmatter?.[1]).toMatch(/^description: \S/m);

    const lines = text.replace(/\r?\n$/, '').split('\n').length;
    expect(lines, `SKILL.md is ${lines} lines; the router must not grow`).toBeLessThanOrEqual(
      SKILL_MAX_LINES,
    );
  });
});

describe('b. every CLI the operator layer names exists', () => {
  const referenced = [...new Set(DOCS.flatMap((doc) => binScriptsIn(doc.text)))].sort();

  it('names at least the review-cycle CLIs', () => {
    expect(referenced).toContain('tick');
    expect(referenced).toContain('propose');
    expect(referenced).toContain('decide');
  });

  /** A loop the router calls `available` must have a mode file, or the run stops at step 1. */
  it('ships a mode file for every loop the router marks available', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    const rows = [
      ...skill.matchAll(/\|\s*`([a-z-]+)`\s*\|\s*`(modes\/[a-z-]+\.md)`\s*\|\s*(\w+)/g),
    ];
    expect(rows.length, 'the router lists no loops').toBeGreaterThan(0);
    const available = rows.filter((row) => row[3] === 'available');
    expect(available.map((row) => row[1])).toEqual(['review-cycle', 'interview-loop']);
    for (const row of available) {
      expect(
        existsSync(path.join(REPO_ROOT, row[2] ?? '')),
        `${row[2]} is marked available in SKILL.md but does not exist`,
      ).toBe(true);
    }
  });

  /** Loop 2 is the "one engine, two loops" claim: it may not grow a script of its own. */
  it('interview-loop.md calls only the shared bin/ scripts', () => {
    const mode = DOCS.find((doc) => doc.name.endsWith('interview-loop.md'));
    expect(mode, 'modes/interview-loop.md is missing').toBeDefined();
    const scripts = [...new Set(binScriptsIn(mode?.text ?? ''))].sort();
    expect(scripts).toContain('tick');
    expect(scripts).toContain('decide');
    const shared = new Set([
      'audit',
      'cycle',
      'decide',
      'doctor',
      'nudge',
      'packet',
      'propose',
      'seed',
      'tick',
      'verify-loops',
    ]);
    const strangers = scripts.filter((script) => !shared.has(script));
    expect(
      strangers,
      `interview-loop.md names a script of its own: ${strangers.join(', ')}`,
    ).toEqual([]);
  });

  /** The one thing loop 2 exists to make impossible must be said in the mode file. */
  it('interview-loop.md says advance/reject is only ever a proposal', () => {
    const text = DOCS.find((doc) => doc.name.endsWith('interview-loop.md'))?.text ?? '';
    expect(text).toContain('propose');
    expect(text).toContain('advance_stage');
    expect(text).toContain('decide.mjs');
    expect(text.toLowerCase()).toContain('never writes a stage');
  });

  for (const script of referenced) {
    const where = DOCS.filter((doc) => binScriptsIn(doc.text).includes(script))
      .map((doc) => doc.name)
      .join(', ');
    it(`bin/${script}.mjs exists (named in ${where})`, () => {
      expect(existsSync(path.join(REPO_ROOT, 'bin', `${script}.mjs`))).toBe(true);
    });
  }
});

describe('c. every flag in a documented command is a real flag', () => {
  const uses = DOCS.flatMap((doc) =>
    commandUsesIn(doc.text).map((use) => ({ ...use, doc: doc.name })),
  );

  it('finds commands to check', () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  const scripts = [...new Set(uses.map((use) => use.script))].sort();
  for (const script of scripts) {
    const flags = [...new Set(uses.filter((u) => u.script === script).flatMap((u) => u.flags))];
    it(`bin/${script}.mjs --help documents ${flags.join(' ') || '(no flags)'}`, () => {
      expect(
        existsSync(path.join(REPO_ROOT, 'bin', `${script}.mjs`)),
        `bin/${script}.mjs is used in the modes but does not exist`,
      ).toBe(true);
      const help = helpText(script);
      for (const flag of flags) {
        expect(help, `bin/${script}.mjs --help does not mention ${flag}`).toContain(flag);
      }
    });
  }
});

describe('d. _tenant.md restates tenant/policy.yml exactly', () => {
  const policy = loadPolicy();
  const tenantDoc = DOCS.find((doc) => doc.name.endsWith('_tenant.md'));
  const text = tenantDoc?.text ?? '';

  const pairs = [...text.matchAll(/`([a-z_]+(?:\.[a-z_]+)*):[ \t]+([^`]+)`/g)]
    .map((m) => ({ dotted: m[1] ?? '', raw: m[2] ?? '' }))
    .filter((pair) =>
      (POLICY_TOP_LEVEL_KEYS as readonly string[]).includes(pair.dotted.split('.')[0] ?? ''),
    );

  it('is present and marked as generated from the YAML', () => {
    expect(tenantDoc, 'modes/_tenant.md is missing').toBeDefined();
    expect(text).toContain('generated-from: tenant/policy.yml');
    expect(pairs.length).toBeGreaterThan(0);
  });

  for (const { dotted, raw } of pairs) {
    it(`${dotted} matches the policy`, () => {
      const expected = valueAt(policy, dotted);
      expect(expected, `${dotted} is not a key of tenant/policy.yml`).toBeDefined();
      expect(coerceScalar(raw)).toBe(expected);
    });
  }

  it('mentions every leaf key of the policy', () => {
    const mentioned = new Set(pairs.map((p) => p.dotted));
    const missing = leafPaths(policy).filter((leaf) => !mentioned.has(leaf));
    expect(missing, `unmentioned policy keys: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('e. _shared.md carries the safety rules', () => {
  const shared = DOCS.find((doc) => doc.name.endsWith('_shared.md'));

  it('names the proposal path, the anomaly record, and the no-edit rule', () => {
    expect(shared, 'modes/_shared.md is missing').toBeDefined();
    const text = shared?.text ?? '';
    expect(text).toContain('propose.mjs');
    expect(text).toContain('decide.mjs');
    expect(text).toContain('tl_anomaly');
    expect(text.toLowerCase()).toContain('never edit');
  });
});

describe('f. no mode escapes the repo', () => {
  const ABSOLUTE = /(?:^|[\s(`"'])\/(?:Users|home|Volumes|opt|usr|var|tmp|private|etc)\//;

  for (const doc of DOCS) {
    it(`${doc.name} has no absolute or parent-relative path`, () => {
      expect(doc.text, `${doc.name} reaches outside the repo with "../"`).not.toContain('../');
      expect(ABSOLUTE.test(doc.text), `${doc.name} hard-codes an absolute path`).toBe(false);
    });
  }
});
