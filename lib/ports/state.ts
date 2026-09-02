/**
 * lib/ports/state.ts — persistence for tl_* engine state (Tier 2 + Tier 3).
 *
 * Owns: `StatePort`, generic over the kind→record map in `lib/types/engine.ts`, so
 * `get('task', id)` is typed `TlTask | null` without a cast. Ids are assigned by the
 * adapter (never `max+1`), which is why `create` takes a record without one.
 *
 * Public interface: `StatePort`, `StateFilter`.
 *
 * Rippling backing (research 06 — custom objects are full CRUD on both surfaces):
 *   get    -> codemode.lookup_custom_record   | REST GET  /custom-objects/{obj}/records/{id}
 *   list   -> codemode.list_custom_records / search_custom_records
 *                                             | REST GET  /custom-objects/{obj}/records
 *   create -> codemode.create_custom_record   | REST POST /custom-objects/{obj}/records
 *   update -> codemode.update_custom_record   | REST PATCH /custom-objects/{obj}/records/{id}
 * `delete_custom_record` exists on Rippling and is deliberately NOT exposed here.
 *
 * Spec: docs/SPEC.md §3 (tier 2), §6, §9; docs/PLAN.md §2.3, §2.8.
 */

import type { NewRecord, RecordPatch, StateKind, StateRecordMap } from '#lib/types/engine.ts';

/** Equality filter over a record's own fields; all clauses AND-ed. */
export type StateFilter<K extends StateKind> = Partial<StateRecordMap[K]>;

export interface StatePort {
  get<K extends StateKind>(kind: K, id: string): Promise<StateRecordMap[K] | null>;
  list<K extends StateKind>(kind: K, filter?: StateFilter<K>): Promise<StateRecordMap[K][]>;
  /** The adapter assigns `id` (`tl_<kind>_<8 hex>`), timestamps, and the acting actor. */
  create<K extends StateKind>(
    kind: K,
    record: NewRecord<StateRecordMap[K]>,
  ): Promise<StateRecordMap[K]>;
  update<K extends StateKind>(
    kind: K,
    id: string,
    patch: RecordPatch<StateRecordMap[K]>,
  ): Promise<StateRecordMap[K]>;
}
