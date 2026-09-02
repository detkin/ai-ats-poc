/**
 * lib/cli/seed.ts — regenerate, verify or reset the fixture tenant (block B0.4, thinned by B1.3).
 *
 * Owns the three cold-start fixture operations as testable functions. They used to live
 * inside `bin/seed.mjs`, which made them reachable only through a subprocess
 * (docs/testing/M0-report.md defects D-1 and D-2, docs/DECISIONS.md D11):
 *
 *   seedWrite(...)   regenerate `fixtures/tenant/**` from the seed integer
 *   seedVerify(...)  regenerate into a temp dir and diff manifests — catches a hand-edited
 *                    file even when its hash was re-written into the manifest
 *   seedReset(...)   copy the seeded `state/` into `TL_DATA_DIR` and start the ledger empty
 *
 * Directories come from `loadConfig()` (`TL_DATA_DIR`, `TL_FIXTURES_DIR`) so `lib/config.ts`
 * stays the only owner of the environment knobs; `--dir` still overrides the fixtures dir.
 *
 * Public interface: `SEED_SPEC`, `runSeed`, `seedWrite`, `seedVerify`, `seedReset`,
 * `diffManifests`, `SeedOptions`.
 *
 * Spec: docs/PLAN.md §2.7, §2.8, §2.9; docs/DECISIONS.md D11.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { UsageError } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { loadConfig } from '#lib/config.ts';
import type { Config } from '#lib/config.ts';
import {
  DEFAULT_SEED,
  LEDGER_FILE,
  generateTenant,
  readManifest,
  verifyManifest,
  writeTenant,
} from '#lib/fixtures/index.ts';
import type { FixtureManifest } from '#lib/fixtures/index.ts';

export const SEED_SPEC: CliSpec = {
  name: 'seed.mjs',
  summary: 'regenerate, verify or reset the fixture tenant',
  usage: ['bin/seed.mjs [--verify | --reset] [--dir <path>] [--seed <n>] [--json]'],
  flags: [
    {
      name: 'verify',
      type: 'boolean',
      description: 'regenerate in a temp dir and compare manifests; exit 1 on any difference',
    },
    {
      name: 'reset',
      type: 'boolean',
      description: 'copy fixtures/tenant/state into TL_DATA_DIR and empty the ledger',
    },
    {
      name: 'dir',
      type: 'string',
      value: '<path>',
      description: 'fixtures directory (default: TL_FIXTURES_DIR, else fixtures/tenant)',
    },
    {
      name: 'seed',
      type: 'string',
      value: '<n>',
      description: `generator seed (default ${DEFAULT_SEED})`,
    },
  ],
  notes: ['With no flag, the fixture tenant is regenerated into the fixtures directory.'],
};

export interface SeedOptions {
  fixturesDir: string;
  dataDir: string;
  seed: number;
}

/** Argument wins, then `TL_FIXTURES_DIR` / the default, both resolved by `lib/config.ts`. */
export function resolveOptions(config: Config, dir: string | undefined, seed: number): SeedOptions {
  return {
    fixturesDir: dir === undefined || dir.length === 0 ? config.fixturesDir : resolve(dir),
    dataDir: config.dataDir,
    seed,
  };
}

/** Human-readable differences between a committed manifest and a freshly generated one. */
export function diffManifests(regenerated: FixtureManifest, committed: FixtureManifest): string[] {
  const differences: string[] = [];
  const regeneratedFiles = Object.keys(regenerated.files ?? {});
  const committedFiles = Object.keys(committed.files ?? {});

  for (const file of regeneratedFiles) {
    if (!committedFiles.includes(file))
      differences.push(`${file}: missing from the committed manifest`);
  }
  for (const file of committedFiles) {
    if (!regeneratedFiles.includes(file))
      differences.push(`${file}: committed but no longer generated`);
  }
  for (const file of regeneratedFiles) {
    const want = regenerated.files[file];
    const have = committed.files?.[file];
    if (want === undefined || have === undefined) continue;
    if (want.sha256 !== have.sha256) {
      differences.push(
        `${file}: sha256 ${have.sha256.slice(0, 12)}… on disk, ${want.sha256.slice(0, 12)}… regenerated`,
      );
    } else if (want.count !== have.count) {
      differences.push(`${file}: count ${have.count} on disk, ${want.count} regenerated`);
    }
  }
  if (regenerated.seed !== committed.seed) {
    differences.push(`seed: ${committed.seed} on disk, ${regenerated.seed} regenerated`);
  }
  if (regenerated.generator_version !== committed.generator_version) {
    differences.push(
      `generator_version: ${committed.generator_version} on disk, ${regenerated.generator_version} regenerated`,
    );
  }
  if (regenerated.anchor_now !== committed.anchor_now) {
    differences.push(
      `anchor_now: ${committed.anchor_now} on disk, ${regenerated.anchor_now} regenerated`,
    );
  }
  return differences;
}

/** Regenerate the tenant into `fixturesDir`. */
export function seedWrite(options: SeedOptions): CliOutput {
  const bundle = generateTenant(options.seed);
  const manifest = writeTenant(bundle, options.fixturesDir, { seed: options.seed });
  const files = Object.keys(manifest.files).length;
  return ok({ ok: true, mode: 'write', dir: options.fixturesDir, seed: options.seed, files }, [
    `Wrote ${files} files to ${options.fixturesDir}`,
    `  workers ${bundle.workers.length}  candidates ${bundle.candidates.length}  applications ${bundle.applications.length}`,
    `  seed ${options.seed}  anchor ${manifest.anchor_now}`,
  ]);
}

/** Verify the committed fixtures against their manifest **and** against a fresh generation. */
export function seedVerify(options: SeedOptions): CliOutput {
  if (!existsSync(options.fixturesDir)) {
    return fail({ ok: false, mode: 'verify', dir: options.fixturesDir, problems: ['missing'] }, [
      `Fixtures directory ${options.fixturesDir} does not exist. Run: npm run seed`,
    ]);
  }

  const onDisk = verifyManifest(options.fixturesDir);
  const committed = readManifest(options.fixturesDir);
  const temp = mkdtempSync(join(tmpdir(), 'tl-seed-verify-'));
  let differences: string[] = [];
  try {
    const seed = committed.seed ?? options.seed;
    differences = diffManifests(writeTenant(generateTenant(seed), temp, { seed }), committed);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const problems = [...onDisk.problems, ...differences];
  const payload = { ok: problems.length === 0, mode: 'verify', dir: options.fixturesDir, problems };
  if (problems.length === 0) {
    return ok(payload, [
      `Fixtures at ${options.fixturesDir} match the manifest and regenerate identically.`,
    ]);
  }
  return fail(payload, [
    `Fixtures at ${options.fixturesDir} do not match a fresh generation (${problems.length} problem(s)):`,
    ...problems.slice(0, 20).map((problem) => `  - ${problem}`),
    ...(problems.length > 20 ? [`  … and ${problems.length - 20} more`] : []),
    'Regenerate with: npm run seed',
  ]);
}

/**
 * Copy the seeded `state/` into `TL_DATA_DIR` and start the ledger empty.
 *
 * The seed ships its (empty) ledger inside `state/`, but the runtime keeps it at the data-dir
 * root, so the copied `state/ledger.jsonl` is removed and the root file written instead —
 * otherwise the ledger would live in two places, which is the drift this project exists to avoid.
 */
export function seedReset(options: SeedOptions): CliOutput {
  const stateSource = join(options.fixturesDir, 'state');
  if (!existsSync(stateSource)) {
    return fail({ ok: false, mode: 'reset', problems: ['fixtures state/ is missing'] }, [
      `No seeded state at ${stateSource}. Run: npm run seed`,
    ]);
  }

  mkdirSync(join(options.dataDir, 'state'), { recursive: true });
  cpSync(stateSource, join(options.dataDir, 'state'), { recursive: true });
  rmSync(join(options.dataDir, 'state', 'ledger.jsonl'), { force: true });

  const ledgerSource = join(options.fixturesDir, LEDGER_FILE);
  const ledgerTarget = join(options.dataDir, 'ledger.jsonl');
  if (existsSync(ledgerSource)) cpSync(ledgerSource, ledgerTarget);
  else writeFileSync(ledgerTarget, '', 'utf8');

  // Scratch from a previous run must not survive a reset: last-tick state would make a
  // fresh cycle look already-ticked.
  rmSync(join(options.dataDir, 'ticks'), { recursive: true, force: true });
  rmSync(join(options.dataDir, 'locks'), { recursive: true, force: true });
  rmSync(join(options.dataDir, 'outbox.jsonl'), { force: true });

  return ok({ ok: true, mode: 'reset', data_dir: options.dataDir }, [
    `Reset runtime state in ${options.dataDir} from ${options.fixturesDir}`,
    `  state/*.json and ledger.jsonl are ready; the ledger starts empty.`,
  ]);
}

export async function runSeed(args: Args): Promise<CliOutput> {
  const rawSeed = args.get('seed');
  const seed = rawSeed === undefined ? DEFAULT_SEED : Number(rawSeed);
  if (!Number.isFinite(seed)) {
    throw new UsageError(`seed.mjs: --seed "${rawSeed}" must be a number`);
  }
  const options = resolveOptions(loadConfig(), args.get('dir'), seed);

  if (args.bool('verify')) return seedVerify(options);
  if (args.bool('reset')) return seedReset(options);
  return seedWrite(options);
}
