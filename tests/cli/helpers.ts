/**
 * tests/cli/helpers.ts — a temp tenant runtime and an in-process CLI runner (block B1.3).
 *
 * Not a test file (vitest only collects `*.test.ts`). Two things live here:
 *
 *  - `seedDataDir()` — a fresh `TL_DATA_DIR` seeded through `lib/cli/seed.ts`'s own reset
 *    function rather than a subprocess, so the CLI tests exercise the same code path
 *    `bin/seed.mjs --reset` does and start in under a millisecond.
 *  - `runCli(spec, handler, argv)` — runs a CLI in this process with stdout/stderr captured,
 *    returning `{ code, stdout, stderr }`. The alternative, spawning `node bin/*.mjs`, would
 *    cost a process and a tenant load per assertion and hide stack traces.
 *
 * Every test sets `TL_NOW` explicitly: nothing here may depend on the wall clock
 * (docs/DECISIONS.md D8).
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliSpec, Args } from '#lib/cli/args.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { runCli as runCliImpl } from '#lib/cli/runtime.ts';
import { resolveOptions, seedReset } from '#lib/cli/seed.ts';
import { loadConfig } from '#lib/config.ts';
import { DEFAULT_SEED } from '#lib/fixtures/index.ts';
import type { TlAgentAction, StateKind, StateRecordMap } from '#lib/types/engine.ts';

/** The fixture anchor and the two other instants the loop-1 scenario uses. */
export const OPEN_AT = '2026-08-24T16:00:00Z';
export const ANCHOR = '2026-09-02T16:00:00Z';

const dataDirs: string[] = [];

/** A fresh, seeded `TL_DATA_DIR`; also exported into the environment for the CLIs. */
export function seedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tl-cli-'));
  dataDirs.push(dir);
  const config = loadConfig({ ...process.env, TL_DATA_DIR: dir });
  const result = seedReset(resolveOptions(config, undefined, DEFAULT_SEED));
  if (result.code !== 0) throw new Error(`seedReset failed: ${result.lines.join(' ')}`);
  process.env.TL_DATA_DIR = dir;
  return dir;
}

/** Remove every temp data dir this file handed out. */
export function cleanupDataDirs(): void {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/** Freeze the clock for the calls that follow. */
export function setNow(instant: string): void {
  process.env.TL_NOW = instant;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one CLI in-process with the streams captured. */
export async function runCli(
  spec: CliSpec,
  handler: (args: Args) => Promise<CliOutput>,
  argv: string[],
  usageExit?: number,
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  try {
    const code =
      usageExit === undefined
        ? await runCliImpl(spec, argv, handler)
        : await runCliImpl(spec, argv, handler, usageExit);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Run a CLI with `--json` and parse stdout. Fails loudly when the run did not produce JSON. */
export async function runJson<T>(
  spec: CliSpec,
  handler: (args: Args) => Promise<CliOutput>,
  argv: string[],
): Promise<{ run: CliRun; data: T }> {
  const run = await runCli(spec, handler, [...argv, '--json']);
  if (run.stdout.trim().length === 0) {
    throw new Error(`${spec.name} printed nothing (exit ${run.code}): ${run.stderr}`);
  }
  return { run, data: JSON.parse(run.stdout) as T };
}

/* ------------------------------------------------------------ reading state */

/** One `tl_*` state file from a data dir. */
export function readState<K extends StateKind>(dataDir: string, file: string): StateRecordMap[K][] {
  const path = join(dataDir, 'state', file);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as StateRecordMap[K][];
}

/** Every ledger line, parsed. */
export function readLedger(dataDir: string): TlAgentAction[] {
  const path = join(dataDir, 'ledger.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TlAgentAction);
}

export interface OutboxLine {
  ts: string;
  actor: string;
  to_worker_id?: string;
  template_id: string;
  text: string;
  message_ref: string;
}

/** Every outbound message the fixture channel adapter recorded. */
export function readOutbox(dataDir: string): OutboxLine[] {
  const path = join(dataDir, 'outbox.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OutboxLine);
}
