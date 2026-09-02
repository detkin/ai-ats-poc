/**
 * lib/adapters/fixture/state.ts — Tier-2/3 `tl_*` records as JSON files.
 *
 * Owns: `FixtureStateAdapter`. One JSON array per kind under `TL_DATA_DIR/state/`, named by
 * `STATE_FILE_BY_KIND` (plural: kind `cycle` lives in `state/cycles.json`) so the runtime
 * layout is byte-identical to the seed `bin/seed.mjs --reset` copies in.
 *
 * The four rules this adapter enforces, so no caller has to remember them:
 *  1. **Ids are assigned here** — `tl_<kind>_<8 hex>` from `crypto`, never `max + 1`.
 *  2. **Provenance is immutable** — `id`, `created_at` and `created_by` cannot be patched.
 *  3. **Status moves are legal moves** — a patch that changes `status` on a cycle, task or
 *     proposed action is checked against `templates/loop-states.yml` (`assertTransition`).
 *  4. **Writes are atomic** — temp file plus `rename`, so a killed tick leaves whole files.
 * There is no `delete`: `StatePort` has none, and corrections are updates (spec §9).
 *
 * Public interface: `FixtureStateAdapter` (implements `StatePort`), `RuntimeStateMissingError`,
 * `StateRecordNotFoundError`, `ImmutableFieldError`, `STATE_DIRNAME`, `machineForKind`.
 *
 * Rippling calls this stands in for: codemode.lookup_custom_record / list_custom_records /
 * create_custom_record / update_custom_record | REST /custom-objects/{obj}/records.
 *
 * Spec: docs/SPEC.md §3 (tier 2), §6, §9; docs/PLAN.md §2.3, §2.8.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { newId, toInstant, writeJsonAtomic } from '#lib/adapters/fixture/ledger.ts';
import { STATE_FILES, STATE_FILE_BY_KIND } from '#lib/fixtures/index.ts';
import type { StateFilter, StatePort } from '#lib/ports/state.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import { assertTransition, canonicalState } from '#lib/states/index.ts';
import type { LoopStates, MachineName } from '#lib/states/index.ts';
import type { NewRecord, RecordPatch, StateKind, StateRecordMap } from '#lib/types/engine.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

/** Runtime state directory, relative to `TL_DATA_DIR`. */
export const STATE_DIRNAME = 'state';

/** Fields no patch may change. */
const IMMUTABLE_FIELDS = ['id', 'created_at', 'created_by'] as const;

/** `TL_DATA_DIR/state` does not exist — the runtime was never seeded. */
export class RuntimeStateMissingError extends TalentLoopsError {
  readonly dataDir: string;

  constructor(dataDir: string) {
    super(
      'RUNTIME_STATE_MISSING',
      `no runtime state at ${join(dataDir, STATE_DIRNAME)}. Seed it with: node bin/seed.mjs --reset`,
    );
    this.name = 'RuntimeStateMissingError';
    this.dataDir = dataDir;
  }
}

/** `update` was called with an id that is not in the file. */
export class StateRecordNotFoundError extends TalentLoopsError {
  readonly kind: string;
  readonly record_id: string;

  constructor(kind: string, id: string) {
    super('STATE_RECORD_NOT_FOUND', `no ${kind} record with id "${id}"`);
    this.name = 'StateRecordNotFoundError';
    this.kind = kind;
    this.record_id = id;
  }
}

/** A patch tried to rewrite identity or provenance. */
export class ImmutableFieldError extends TalentLoopsError {
  readonly field: string;

  constructor(kind: string, id: string, field: string) {
    super(
      'IMMUTABLE_FIELD',
      `cannot change "${field}" on ${kind} "${id}": id, created_at and created_by are immutable.`,
    );
    this.name = 'ImmutableFieldError';
    this.field = field;
  }
}

/** The state machine that governs a kind's `status`, or `null` when it has none. */
export function machineForKind(kind: StateKind): MachineName | null {
  if (kind === 'cycle') return 'cycle';
  if (kind === 'task') return 'task';
  if (kind === 'proposed_action') return 'proposal';
  return null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Structural equality good enough for filter clauses over JSON records. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export class FixtureStateAdapter implements StatePort {
  private readonly dataDir: string;
  private readonly actorWorkerId: WorkerId;
  private readonly now: () => Date;
  private readonly states: LoopStates | undefined;

  constructor(dataDir: string, actorWorkerId: WorkerId, now: () => Date, states?: LoopStates) {
    this.dataDir = dataDir;
    this.actorWorkerId = actorWorkerId;
    this.now = now;
    this.states = states;
  }

  private pathFor(kind: StateKind): string {
    const stateDir = join(this.dataDir, STATE_DIRNAME);
    if (!existsSync(stateDir)) throw new RuntimeStateMissingError(this.dataDir);
    const bundleKey = STATE_FILE_BY_KIND[kind];
    if (bundleKey === undefined) {
      throw new TalentLoopsError('UNKNOWN_STATE_KIND', `"${kind}" is not a tl_* state kind`);
    }
    return join(this.dataDir, ...STATE_FILES[bundleKey].split('/'));
  }

  private readAll<K extends StateKind>(kind: K): StateRecordMap[K][] {
    const path = this.pathFor(kind);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new TalentLoopsError(
        'STATE_FILE_CORRUPT',
        `${path} does not contain a JSON array. Restore it with: node bin/seed.mjs --reset`,
      );
    }
    return parsed as StateRecordMap[K][];
  }

  /** Validate a status against the kind's machine, when it has one. */
  private assertKnownStatus(kind: StateKind, status: unknown): void {
    const machine = machineForKind(kind);
    if (machine === null || typeof status !== 'string') return;
    canonicalState(machine, status, this.states);
  }

  async get<K extends StateKind>(kind: K, id: string): Promise<StateRecordMap[K] | null> {
    const found = this.readAll(kind).find((record) => record.id === id);
    return found === undefined ? null : found;
  }

  async list<K extends StateKind>(kind: K, filter?: StateFilter<K>): Promise<StateRecordMap[K][]> {
    const all = this.readAll(kind);
    if (filter === undefined) return all;
    const clauses = Object.entries(filter).filter(([, value]) => value !== undefined);
    return all.filter((record) =>
      clauses.every(([key, value]) =>
        sameValue((record as unknown as Record<string, unknown>)[key], value),
      ),
    );
  }

  /**
   * Assigns the id, both timestamps and — unless the caller named one — `created_by` from
   * the acting identity. The id is re-drawn on the (astronomically unlikely) collision.
   */
  async create<K extends StateKind>(
    kind: K,
    record: NewRecord<StateRecordMap[K]>,
  ): Promise<StateRecordMap[K]> {
    const all = this.readAll(kind);
    const taken = new Set(all.map((existing) => existing.id));
    let id = newId(kind);
    while (taken.has(id)) id = newId(kind);

    const input = record as Record<string, unknown>;
    if (hasOwn(input, 'status')) this.assertKnownStatus(kind, input.status);

    const ts = toInstant(this.now());
    const created = {
      ...input,
      id,
      created_at: ts,
      updated_at: ts,
      created_by:
        typeof input.created_by === 'string' && input.created_by.length > 0
          ? input.created_by
          : this.actorWorkerId,
    } as StateRecordMap[K];

    writeJsonAtomic(this.pathFor(kind), [...all, created]);
    return created;
  }

  /**
   * Merge a patch into an existing record. Refuses unknown ids, refuses to rewrite identity
   * or provenance, and refuses a `status` move the states contract does not declare.
   */
  async update<K extends StateKind>(
    kind: K,
    id: string,
    patch: RecordPatch<StateRecordMap[K]>,
  ): Promise<StateRecordMap[K]> {
    const all = this.readAll(kind);
    const index = all.findIndex((record) => record.id === id);
    const current = all[index];
    if (index === -1 || current === undefined) throw new StateRecordNotFoundError(kind, id);

    const changes = patch as Record<string, unknown>;
    for (const field of IMMUTABLE_FIELDS) {
      if (
        hasOwn(changes, field) &&
        !sameValue(changes[field], (current as unknown as Record<string, unknown>)[field])
      ) {
        throw new ImmutableFieldError(kind, id, field);
      }
    }

    const machine = machineForKind(kind);
    const nextStatus = changes.status;
    const currentStatus = (current as unknown as Record<string, unknown>).status;
    if (
      machine !== null &&
      typeof nextStatus === 'string' &&
      typeof currentStatus === 'string' &&
      nextStatus !== currentStatus
    ) {
      assertTransition(machine, currentStatus, nextStatus, this.states);
    }

    const applied: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      applied[key] = value;
    }
    const updated = {
      ...applied,
      id: current.id,
      created_at: (current as unknown as Record<string, unknown>).created_at,
      created_by: (current as unknown as Record<string, unknown>).created_by,
      updated_at: toInstant(this.now()),
    } as StateRecordMap[K];

    const next = [...all];
    next[index] = updated;
    writeJsonAtomic(this.pathFor(kind), next);
    return updated;
  }
}
