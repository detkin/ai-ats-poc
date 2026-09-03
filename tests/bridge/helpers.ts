/**
 * tests/bridge/helpers.ts — the synthetic snapshot, and where it lives on disk.
 *
 * Not a test file (vitest collects `*.test.ts` only). `sample-snapshot.json` is fabricated —
 * fake names, fake ids, a fake company — but every record is in the shape the live Rippling
 * MCP returned on 2026-09-02 (docs/testing/live-rippling.md), including the parts that broke
 * the fixture assumptions: no location timezone or hours, `teams: null`, `level: null`,
 * present-tense absence, a nested department and a Berlin address.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BridgeSnapshot } from '#lib/adapters/bridge/index.ts';

/** Absolute path to the committed synthetic snapshot. */
export const SAMPLE_SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sample-snapshot.json',
);

/** A fresh, mutable copy — tests edit it to probe one rule at a time. */
export function sampleSnapshot(): BridgeSnapshot {
  return JSON.parse(readFileSync(SAMPLE_SNAPSHOT_PATH, 'utf8')) as BridgeSnapshot;
}
