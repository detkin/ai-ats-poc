/**
 * lib/adapters/bridge/import.ts — a fetched snapshot becomes a readable tenant (block B2.6).
 *
 * Owns: `importSnapshot(path, config, policy)` — read the agent's JSON, validate it, map it,
 * and write the result into `TL_DATA_DIR/tier1/` under exactly the file names
 * `fixtures/tenant/` uses, so the fixture port classes read a real tenant with no change at
 * all. Also owns `readProvenance` / `provenancePath`, which the runtime and `bin/doctor.mjs`
 * use to tell a bridged data dir from an empty one.
 *
 * Two rules the writer keeps:
 *  - **Re-import replaces Tier 1 only.** `TL_DATA_DIR/state/*.json` and `ledger.jsonl` are
 *    seeded when absent and never overwritten: the user may re-fetch mid-cycle, and a
 *    refreshed org chart must not erase the cycle running over it.
 *  - **Nothing is written to Rippling.** The import is one-way by construction; there is no
 *    code path from here back out to the MCP.
 *
 * Public interface: `importSnapshot`, `ImportResult`, `TIER1_DIRNAME`, `PROVENANCE_FILE`,
 * `provenancePath`, `readProvenance`, `readSnapshotFile`.
 *
 * Spec: docs/PLAN.md §8, §2.8; docs/DECISIONS.md D25.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mapSnapshot } from '#lib/adapters/bridge/map.ts';
import type { Provenance } from '#lib/adapters/bridge/map.ts';
import { BridgeSnapshotInvalidError, validateSnapshot } from '#lib/adapters/bridge/snapshot.ts';
import type { BridgeSnapshot } from '#lib/adapters/bridge/snapshot.ts';
import type { Config } from '#lib/config.ts';
import { STATE_FILES, serializeJson, writeTenant } from '#lib/fixtures/index.ts';
import type { TenantPolicy } from '#lib/policy/index.ts';

/** Tier-1 data lives beside runtime state, not inside it. */
export const TIER1_DIRNAME = 'tier1';
export const PROVENANCE_FILE = 'provenance.json';

/** `<TL_DATA_DIR>/tier1/provenance.json`. */
export function provenancePath(dataDir: string): string {
  return join(dataDir, TIER1_DIRNAME, PROVENANCE_FILE);
}

/** The provenance of an imported tenant, or `null` when this data dir was never imported. */
export function readProvenance(dataDir: string): Provenance | null {
  const path = provenancePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Provenance;
  } catch {
    return null;
  }
}

/** Read and parse a snapshot file, raising `BridgeSnapshotInvalidError` on anything wrong. */
export function readSnapshotFile(path: string): BridgeSnapshot {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new BridgeSnapshotInvalidError(path, [
      `cannot read the file: ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new BridgeSnapshotInvalidError(path, [
      `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }
  const { ok, errors } = validateSnapshot(parsed);
  if (!ok) throw new BridgeSnapshotInvalidError(path, errors);
  return parsed as BridgeSnapshot;
}

export interface ImportResult {
  /** Where the Tier-1 files were written. */
  tier1Dir: string;
  provenance: Provenance;
  warnings: string[];
  /** True when this import also created the empty runtime state and ledger. */
  seededState: boolean;
}

/** Seed `TL_DATA_DIR/state/*.json` and `ledger.jsonl` if, and only if, they are absent. */
function seedRuntimeState(dataDir: string): boolean {
  const stateDir = join(dataDir, 'state');
  const ledger = join(dataDir, 'ledger.jsonl');
  let seeded = false;
  mkdirSync(stateDir, { recursive: true });
  for (const file of Object.values(STATE_FILES) as string[]) {
    // STATE_FILES paths are `state/<name>.json`, relative to a tenant dir.
    const target = join(dataDir, file);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, serializeJson([]), 'utf8');
    seeded = true;
  }
  if (!existsSync(ledger)) {
    writeFileSync(ledger, '', 'utf8');
    seeded = true;
  }
  return seeded;
}

/**
 * Import a snapshot into `config.dataDir`.
 *
 * ```sh
 * node bin/bridge.mjs import --from data-live/bridge/snapshot.json
 * ```
 *
 * @throws BridgeSnapshotInvalidError when the file cannot be read, parsed or validated.
 */
export function importSnapshot(path: string, config: Config, policy: TenantPolicy): ImportResult {
  const snapshot = readSnapshotFile(path);
  const { bundle, provenance, warnings } = mapSnapshot(snapshot, policy, config.now);

  const tier1Dir = join(config.dataDir, TIER1_DIRNAME);
  // `writeTenant` lays out exactly the fixture file names, plus the seed `state/` the loader
  // insists on and a manifest. That seeded state is *inside* tier1/ and is never the runtime
  // state: the runtime reads `TL_DATA_DIR/state`, which the block below leaves alone.
  writeTenant(bundle, tier1Dir, { seed: 0 });
  // `loadTenant` requires a résumé directory even when the corpus is empty.
  mkdirSync(join(tier1Dir, 'resumes'), { recursive: true });
  writeFileSync(join(tier1Dir, PROVENANCE_FILE), serializeJson(provenance), 'utf8');
  // Tier-1 files are rewritten wholesale, so the manifest's own file list is stale by one
  // entry (provenance.json). Nothing verifies the bridged manifest; it is a convenience.

  const seededState = seedRuntimeState(config.dataDir);
  return { tier1Dir, provenance, warnings, seededState };
}
