#!/usr/bin/env node
/**
 * bin/seed.mjs — regenerate, verify or reset the fixture tenant.
 *
 * Owns: the three cold-start fixture operations, as a thin CLI over `lib/fixtures/*`.
 *
 *   node bin/seed.mjs            regenerate `fixtures/tenant/**` from the seed
 *   node bin/seed.mjs --verify   regenerate into a temp dir and diff manifests; exit 1 on drift
 *   node bin/seed.mjs --reset    copy the seeded state into TL_DATA_DIR (default ./data)
 *
 * Flags: `--dir <path>` overrides the fixtures dir (else `TL_FIXTURES_DIR`, else the repo's
 * `fixtures/tenant`); `--seed <n>` overrides the generator seed; `--json` prints a machine
 * form. Exit code is 0 on success and 1 on any failure, which is what CI checks.
 *
 * Spec: docs/PLAN.md §2.7, §2.8, §2.9 (CLI contract), §3 block B0.4.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_SEED,
  LEDGER_FILE,
  generateTenant,
  readManifest,
  resolveFixturesDir,
  verifyManifest,
  writeTenant,
} from '#lib/fixtures/index.ts';

function parseArgs(argv) {
  const args = { mode: 'write', dir: undefined, seed: DEFAULT_SEED, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') args.mode = 'verify';
    else if (arg === '--reset') args.mode = 'reset';
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dir') args.dir = argv[++i];
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else {
      console.error(`seed.mjs: unknown argument "${arg}"`);
      process.exit(1);
    }
  }
  return args;
}

const USAGE = `Usage: node bin/seed.mjs [--verify | --reset] [--dir <path>] [--seed <n>] [--json]

  (no flag)   regenerate the fixture tenant into the fixtures dir
  --verify    regenerate in a temp dir and compare manifests; exit 1 on any difference
  --reset     copy fixtures/tenant/state into TL_DATA_DIR (default ./data)
`;

function dataDir() {
  const fromEnv = process.env.TL_DATA_DIR;
  return resolve(fromEnv && fromEnv.length > 0 ? fromEnv : './data');
}

function report(json, payload, lines) {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else for (const line of lines) console.log(line);
}

/** Compare two manifests file by file; returns a list of human-readable differences. */
function diffManifests(expected, actual) {
  const differences = [];
  const expectedFiles = Object.keys(expected.files ?? {});
  const actualFiles = Object.keys(actual.files ?? {});
  for (const file of expectedFiles) {
    if (!actualFiles.includes(file))
      differences.push(`${file}: missing from the committed manifest`);
  }
  for (const file of actualFiles) {
    if (!expectedFiles.includes(file))
      differences.push(`${file}: committed but no longer generated`);
  }
  for (const file of expectedFiles) {
    const want = expected.files[file];
    const have = actual.files?.[file];
    if (!have) continue;
    if (want.sha256 !== have.sha256) {
      differences.push(
        `${file}: sha256 ${have.sha256.slice(0, 12)}… on disk, ${want.sha256.slice(0, 12)}… regenerated`,
      );
    } else if (want.count !== have.count) {
      differences.push(`${file}: count ${have.count} on disk, ${want.count} regenerated`);
    }
  }
  if (expected.seed !== actual.seed) {
    differences.push(`seed: ${actual.seed} on disk, ${expected.seed} regenerated`);
  }
  if (expected.generator_version !== actual.generator_version) {
    differences.push(
      `generator_version: ${actual.generator_version} on disk, ${expected.generator_version} regenerated`,
    );
  }
  if (expected.anchor_now !== actual.anchor_now) {
    differences.push(
      `anchor_now: ${actual.anchor_now} on disk, ${expected.anchor_now} regenerated`,
    );
  }
  return differences;
}

function runWrite(args, fixturesDir) {
  const bundle = generateTenant(args.seed);
  const manifest = writeTenant(bundle, fixturesDir, { seed: args.seed });
  const fileCount = Object.keys(manifest.files).length;
  report(
    args.json,
    { ok: true, mode: 'write', dir: fixturesDir, seed: args.seed, files: fileCount },
    [
      `Wrote ${fileCount} files to ${fixturesDir}`,
      `  workers ${bundle.workers.length}  candidates ${bundle.candidates.length}  applications ${bundle.applications.length}`,
      `  seed ${args.seed}  anchor ${manifest.anchor_now}`,
    ],
  );
  return 0;
}

function runVerify(args, fixturesDir) {
  if (!existsSync(fixturesDir)) {
    report(args.json, { ok: false, mode: 'verify', dir: fixturesDir, problems: ['missing'] }, [
      `Fixtures directory ${fixturesDir} does not exist. Run: npm run seed`,
    ]);
    return 1;
  }

  const onDisk = verifyManifest(fixturesDir);
  const committed = readManifest(fixturesDir);
  const temp = mkdtempSync(join(tmpdir(), 'tl-seed-verify-'));
  let differences = [];
  try {
    const regenerated = writeTenant(generateTenant(committed.seed ?? args.seed), temp, {
      seed: committed.seed ?? args.seed,
    });
    differences = diffManifests(regenerated, committed);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const problems = [...onDisk.problems, ...differences];
  const ok = problems.length === 0;
  report(
    args.json,
    { ok, mode: 'verify', dir: fixturesDir, problems },
    ok
      ? [`Fixtures at ${fixturesDir} match the manifest and regenerate identically.`]
      : [
          `Fixtures at ${fixturesDir} do not match a fresh generation (${problems.length} problem(s)):`,
          ...problems.slice(0, 20).map((problem) => `  - ${problem}`),
          ...(problems.length > 20 ? [`  … and ${problems.length - 20} more`] : []),
          'Regenerate with: npm run seed',
        ],
  );
  return ok ? 0 : 1;
}

function runReset(args, fixturesDir) {
  const target = dataDir();
  const stateSource = join(fixturesDir, 'state');
  if (!existsSync(stateSource)) {
    report(args.json, { ok: false, mode: 'reset', problems: ['fixtures state/ is missing'] }, [
      `No seeded state at ${stateSource}. Run: npm run seed`,
    ]);
    return 1;
  }

  mkdirSync(join(target, 'state'), { recursive: true });
  cpSync(stateSource, join(target, 'state'), { recursive: true });
  rmSync(join(target, 'state', 'ledger.jsonl'), { force: true });

  const ledgerSource = join(fixturesDir, LEDGER_FILE);
  const ledgerTarget = join(target, 'ledger.jsonl');
  if (existsSync(ledgerSource)) cpSync(ledgerSource, ledgerTarget);
  else writeFileSync(ledgerTarget, '', 'utf8');

  report(args.json, { ok: true, mode: 'reset', data_dir: target }, [
    `Reset runtime state in ${target} from ${fixturesDir}`,
    `  state/*.json and ledger.jsonl are ready; the ledger starts empty.`,
  ]);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const fixturesDir = resolveFixturesDir(args.dir);
  if (args.mode === 'verify') return runVerify(args, fixturesDir);
  if (args.mode === 'reset') return runReset(args, fixturesDir);
  return runWrite(args, fixturesDir);
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
