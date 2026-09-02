/**
 * lib/adapters/fixture/ledger.ts — the append-only ledger, plus the file primitives the
 * other fixture adapters share.
 *
 * Owns:
 *  1. `FixtureLedgerAdapter` — `TL_DATA_DIR/ledger.jsonl`, one JSON object per line. The
 *     object has exactly two methods, `append` and `list`: there is no rewrite path, no
 *     truncate, no delete. Corrections are new lines (spec §5, §9).
 *  2. The small file primitives every fixture adapter needs — `toInstant` (the project's
 *     second-precision ISO form), `randomHex` / `newId` (ids are random, never `max + 1`),
 *     `appendJsonLine`, `readJsonLines`, `writeJsonAtomic`. They live here because this is
 *     the lowest module in the fixture stack: it imports no sibling adapter.
 *
 * Public interface: `FixtureLedgerAdapter` (implements `LedgerPort`), `LEDGER_FILENAME`,
 * `toInstant`, `randomHex`, `newId`, `appendJsonLine`, `readJsonLines`, `writeJsonAtomic`.
 *
 * Rippling calls this stands in for: codemode.create_custom_record / search_custom_records
 * on the `tl_agent_action` custom object | REST POST|GET /custom-objects/.../records.
 *
 * Spec: docs/SPEC.md §5, §7 step 5, §9, §10; docs/PLAN.md §2.3, §2.8.
 */

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { LedgerPort, LedgerQuery } from '#lib/ports/ledger.ts';
import type { NewLedgerEntry, TlAgentAction } from '#lib/types/engine.ts';
import type { InstantISO } from '#lib/types/tier1.ts';

/** The ledger file, relative to `TL_DATA_DIR` (docs/PLAN.md §2.8). */
export const LEDGER_FILENAME = 'ledger.jsonl';

/**
 * `YYYY-MM-DDTHH:MM:SSZ` — the `InstantISO` shape the fixtures use. Milliseconds are
 * dropped so a golden ledger diff stays readable.
 */
export function toInstant(date: Date): InstantISO {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `n` bytes of cryptographic randomness as lowercase hex. */
export function randomHex(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

/** `tl_<kind>_<8 hex>` — the id shape every engine record carries (docs/PLAN.md §2.2). */
export function newId(kind: string): string {
  return `tl_${kind}_${randomHex(4)}`;
}

/** Append one JSON object as a line, creating the file and its directory if needed. */
export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

/** Read a `.jsonl` file into parsed objects. A missing file is an empty file. */
export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Write JSON through a temporary file in the same directory and `rename` over the target,
 * so a crash mid-write can never leave half a state file behind.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomHex(4)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/**
 * The fixture ledger. Deliberately minimal: `append` and `list`, nothing else. The ledgered
 * wrapper (lib/adapters/ledgered.ts) is its only routine caller and appends for every port
 * call — ok, rejected or error alike.
 */
export class FixtureLedgerAdapter implements LedgerPort {
  private readonly path: string;
  private readonly now: () => Date;

  constructor(dataDir: string, now: () => Date) {
    this.path = join(dataDir, LEDGER_FILENAME);
    this.now = now;
  }

  /** Assigns `id`; uses the entry's own `ts` when it has one, else the runtime clock. */
  async append(entry: NewLedgerEntry): Promise<TlAgentAction> {
    const ts =
      typeof entry.ts === 'string' && entry.ts.length > 0 ? entry.ts : toInstant(this.now());
    const persisted: TlAgentAction = { ...entry, id: newId('agent_action'), ts };
    appendJsonLine(this.path, persisted);
    return persisted;
  }

  async list(q: LedgerQuery): Promise<TlAgentAction[]> {
    return readJsonLines<TlAgentAction>(this.path).filter((entry) => {
      if (q.cycle_id !== undefined && entry.cycle_id !== q.cycle_id) return false;
      if (q.since !== undefined && entry.ts < q.since) return false;
      return true;
    });
  }
}
