/**
 * tests/adapters/helpers.ts — a throwaway `TL_DATA_DIR` per test file.
 *
 * Owns: `makeDataDir` (copies `fixtures/tenant/state/` into a temp directory exactly the way
 * `node bin/seed.mjs --reset` does), the config/runtime constructors the adapter tests share,
 * and small readers for the three runtime files (`ledger.jsonl`, `outbox.jsonl`, state).
 * Every helper pins `TL_NOW` to the fixture anchor, so tests never depend on the wall clock.
 *
 * Public interface: `ANCHOR_NOW`, `makeDataDir`, `removeDataDir`, `envFor`, `makeConfig`,
 * `makeRuntime`, `readLedger`, `readOutbox`, `writeInbox`, `readStateFile`.
 *
 * Spec: docs/PLAN.md §0 (anchor), §2.8 (runtime layout), §4 block B1.2 tests.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OutboxLine } from '#lib/adapters/fixture/channel.ts';
import { readJsonLines } from '#lib/adapters/fixture/ledger.ts';
import { buildRuntime } from '#lib/adapters/index.ts';
import type { Runtime, RuntimeOptions } from '#lib/adapters/index.ts';
import { loadConfig, repoRoot } from '#lib/config.ts';
import type { Config } from '#lib/config.ts';
import type { TlAgentAction } from '#lib/types/engine.ts';

/** The fixture anchor: Wednesday 2026-09-02, 09:00 Pacific / 21:30 IST. */
export const ANCHOR_NOW = '2026-09-02T16:00:00Z';

/** A fresh `TL_DATA_DIR` seeded from `fixtures/tenant/state/`, the way `--reset` seeds it. */
export function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tl-adapters-'));
  const source = join(repoRoot(), 'fixtures', 'tenant', 'state');
  cpSync(source, join(dir, 'state'), { recursive: true });
  rmSync(join(dir, 'state', 'ledger.jsonl'), { force: true });
  writeFileSync(join(dir, 'ledger.jsonl'), '', 'utf8');
  return dir;
}

export function removeDataDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** The `TL_*` environment a test runs under: fixtures, frozen clock, temp data dir. */
export function envFor(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TL_ADAPTER: 'fixture',
    TL_NOW: ANCHOR_NOW,
    TL_DATA_DIR: dataDir,
    TL_FIXTURES_DIR: join(repoRoot(), 'fixtures', 'tenant'),
    TL_TENANT_DIR: join(repoRoot(), 'tenant'),
    ...extra,
  };
}

export function makeConfig(dataDir: string, extra: NodeJS.ProcessEnv = {}): Config {
  return loadConfig(envFor(dataDir, extra));
}

export function makeRuntime(
  dataDir: string,
  options: RuntimeOptions = {},
  extraEnv: NodeJS.ProcessEnv = {},
): Runtime {
  return buildRuntime(makeConfig(dataDir, extraEnv), options);
}

export function readLedger(dataDir: string): TlAgentAction[] {
  return readJsonLines<TlAgentAction>(join(dataDir, 'ledger.jsonl'));
}

export function readOutbox(dataDir: string): OutboxLine[] {
  return readJsonLines<OutboxLine>(join(dataDir, 'outbox.jsonl'));
}

/** Script Slack replies for `channel.readReplies`. */
export function writeInbox(dataDir: string, lines: Record<string, unknown>[]): void {
  writeFileSync(
    join(dataDir, 'inbox.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  );
}

/** Raw contents of one runtime state file, e.g. `readStateFile(dir, 'tasks')`. */
export function readStateFile<T>(dataDir: string, file: string): T[] {
  return JSON.parse(readFileSync(join(dataDir, 'state', `${file}.json`), 'utf8')) as T[];
}
