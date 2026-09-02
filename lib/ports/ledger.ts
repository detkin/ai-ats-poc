/**
 * lib/ports/ledger.ts — the append-only agent-action ledger.
 *
 * Owns: `LedgerPort`. Every port call appends one `tl_agent_action` with the acting user
 * and their permission context. There is deliberately no `update` and no `delete` on this
 * interface: corrections are new lines (spec §5, career-ops `status-log.tsv` rule).
 *
 * Public interface: `LedgerPort`, `LedgerQuery`.
 *
 * Rippling backing (research 06):
 *   append -> codemode.create_custom_record   | REST POST /custom-objects/tl_agent_action/records
 *   list   -> codemode.search_custom_records  | REST GET  /custom-objects/tl_agent_action/records
 * On fixtures it is `TL_DATA_DIR/ledger.jsonl`, one JSON object per line.
 *
 * Spec: docs/SPEC.md §5, §7 step 5, §9, §10; docs/PLAN.md §2.3.
 */

import type { InstantISO } from '#lib/types/tier1.ts';
import type { NewLedgerEntry, TlAgentAction, TlCycleId } from '#lib/types/engine.ts';

export interface LedgerQuery {
  cycle_id?: TlCycleId;
  /** Inclusive lower bound on `ts`. */
  since?: InstantISO;
}

export interface LedgerPort {
  /** The adapter assigns the id. Returns the persisted entry. */
  append(entry: NewLedgerEntry): Promise<TlAgentAction>;
  list(q: LedgerQuery): Promise<TlAgentAction[]>;
}
