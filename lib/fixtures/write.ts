/**
 * lib/fixtures/write.ts — put a generated tenant on disk, with a manifest.
 *
 * Owns: `writeTenant(bundle, dir)` and the manifest shape from docs/PLAN.md §2.7:
 * `{ anchor_now, generator_version, seed, files: { "<file>": { count, sha256 } } }`.
 * Every file the fixtures dir contains is listed — Tier-1 JSON, the forty résumés, the
 * seeded `state/*.json` and the empty `state/ledger.jsonl` — so `bin/doctor.mjs` and
 * `verifyManifest` can prove the committed data has not drifted or been hand-edited.
 *
 * `count` is the array length for a JSON array, the line count for `.jsonl`, and `1` for a
 * markdown document. `sha256` is over the bytes as written, so the manifest is what the
 * files hash to, not what the generator meant to write.
 *
 * Public interface: `writeTenant`, `FixtureManifest`, `ManifestEntry`, `buildManifest`,
 * `serializeJson`, `hashBytes`.
 *
 * Spec: docs/PLAN.md §2.7, §2.8, §3 block B0.4.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ANCHOR_NOW,
  DEFAULT_SEED,
  GENERATOR_VERSION,
  LEDGER_FILE,
  MANIFEST_FILE,
  STATE_FILES,
  TIER1_FILES,
} from '#lib/fixtures/gen/bundle.ts';
import type { TenantBundle, TenantState, Tier1FileKey } from '#lib/fixtures/gen/bundle.ts';

export interface ManifestEntry {
  count: number;
  sha256: string;
}

export interface FixtureManifest {
  anchor_now: string;
  generator_version: string;
  seed: number;
  files: Record<string, ManifestEntry>;
}

export interface WriteOptions {
  /** Recorded in the manifest so a verify run knows which seed to regenerate from. */
  seed?: number;
}

/** Canonical on-disk JSON: two-space indent, one trailing newline. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashBytes(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/** Lines in a `.jsonl` file; an empty file has none. */
function jsonlLineCount(contents: string): number {
  return contents.split('\n').filter((line) => line.trim().length > 0).length;
}

function countFor(file: string, contents: string, arrayLength: number | null): number {
  if (file.endsWith('.jsonl')) return jsonlLineCount(contents);
  if (arrayLength !== null) return arrayLength;
  return 1;
}

interface PlannedFile {
  /** Path relative to the fixtures dir, always POSIX-separated. */
  file: string;
  contents: string;
  /** Array length for JSON arrays; `null` for documents. */
  arrayLength: number | null;
}

/**
 * The complete, ordered list of files a tenant writes. Order fixes the manifest key order,
 * which keeps `manifest.json` diff-stable across regenerations.
 */
function planFiles(bundle: TenantBundle): PlannedFile[] {
  const planned: PlannedFile[] = [];

  for (const [key, file] of Object.entries(TIER1_FILES) as [Tier1FileKey, string][]) {
    const rows = bundle[key];
    planned.push({ file, contents: serializeJson(rows), arrayLength: rows.length });
  }

  for (const ref of Object.keys(bundle.resumes).sort()) {
    planned.push({ file: ref, contents: bundle.resumes[ref] ?? '', arrayLength: null });
  }

  for (const [key, file] of Object.entries(STATE_FILES) as [keyof TenantState, string][]) {
    const rows = bundle.state[key];
    planned.push({ file, contents: serializeJson(rows), arrayLength: rows.length });
  }

  planned.push({ file: LEDGER_FILE, contents: '', arrayLength: null });

  return planned;
}

export function buildManifest(bundle: TenantBundle, seed: number): FixtureManifest {
  const files: Record<string, ManifestEntry> = {};
  for (const planned of planFiles(bundle)) {
    files[planned.file] = {
      count: countFor(planned.file, planned.contents, planned.arrayLength),
      sha256: hashBytes(planned.contents),
    };
  }
  return {
    anchor_now: ANCHOR_NOW,
    generator_version: GENERATOR_VERSION,
    seed,
    files,
  };
}

/** Delete résumé files a regeneration no longer produces, so the dir cannot accumulate. */
function pruneStaleResumes(dir: string, keep: ReadonlySet<string>): void {
  const resumeDir = join(dir, 'resumes');
  let entries: string[];
  try {
    entries = readdirSync(resumeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (keep.has(`resumes/${entry}`)) continue;
    rmSync(join(resumeDir, entry), { force: true });
  }
}

/**
 * Write `bundle` into `dir`, creating it (and `resumes/`, `state/`) if needed, and return
 * the manifest that was written alongside it.
 */
export function writeTenant(
  bundle: TenantBundle,
  dir: string,
  options: WriteOptions = {},
): FixtureManifest {
  const seed = options.seed ?? DEFAULT_SEED;
  const planned = planFiles(bundle);

  mkdirSync(dir, { recursive: true });
  for (const entry of planned) {
    const target = join(dir, entry.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.contents, 'utf8');
  }
  pruneStaleResumes(dir, new Set(planned.map((entry) => entry.file)));

  const manifest = buildManifest(bundle, seed);
  writeFileSync(join(dir, MANIFEST_FILE), serializeJson(manifest), 'utf8');
  return manifest;
}
