/**
 * lib/ports/freebusy.ts — the *secondary* calendar signal, and the labelled seam it stands on.
 *
 * Owns: `FreeBusyPort` and `BusyBlock`. This is deliberately not one of the seven ports in
 * `lib/ports/index.ts`: it is an implementation detail of the Availability port, composed
 * behind it by `lib/availability/compose.ts`. Nothing outside that composition may hold a
 * `FreeBusyPort`, because a caller holding one could schedule against a calendar alone —
 * exactly the thing spec §4 forbids ("never nudge or hold against Google Calendar alone;
 * Rippling absence wins").
 *
 * **The seam.** Meeting-level free/busy is the one availability signal Rippling's API does
 * not expose, so the POC reads Google Calendar for it and writes interview holds there as a
 * stand-in. On an internal build this port disappears: Rippling's own calendar layer already
 * federates Google/O365 through the Workspace connector and holds Rippling-native events
 * (PTO, holidays, interviews booked by Smart Scheduling) that never reach the backing Google
 * calendar, and the hold becomes a **Smart Scheduling** call rather than an event insert.
 *
 * Public interface: `FreeBusyPort`, `BusyBlock`, `BusyRange`, `HoldWriter`.
 *
 * Google backing (POC): `busy` -> calendar.freebusy.query; `placeHold` -> calendar.events.insert.
 *
 * Spec: docs/SPEC.md §2 (no calendar surface in Rippling), §4 (availability is Rippling-first),
 * §8 loop 2; docs/PLAN.md §2.3, §5 block B2.1; docs/QUESTIONS.md Q3.
 */

import type { HoldInput, HoldResult, Slot } from '#lib/ports/availability.ts';
import type { InstantISO, WorkerId } from '#lib/types/tier1.ts';

/**
 * One block of time a worker's calendar reports as busy. `source` is stamped by the adapter
 * and is always `gcal` in the POC — it exists so a ledger line or a debug dump says *which*
 * authority produced the block, and so a future Rippling-calendar implementation can add its
 * own value without callers guessing.
 */
export interface BusyBlock {
  worker_id: WorkerId;
  start_at: InstantISO;
  end_at: InstantISO;
  source: 'gcal';
}

/** Half-open instant range `[from, to)` for a free/busy query. */
export interface BusyRange {
  from: InstantISO;
  to: InstantISO;
}

/** The secondary signal. Read-mostly; the one write is a calendar hold. */
export interface FreeBusyPort {
  /** Busy blocks overlapping `range`, for every worker asked about. Never absence. */
  busy(workerIds: WorkerId[], range: BusyRange): Promise<BusyBlock[]>;
  /** Create the hold. Callers must go through the composed Availability port, never here. */
  placeHold(slot: Slot, input: HoldInput): Promise<HoldResult>;
}

/**
 * The half of `FreeBusyPort` that writes. `composeAvailability` takes one so an internal
 * build can keep Google for reads and swap Smart Scheduling in for the write.
 */
export type HoldWriter = Pick<FreeBusyPort, 'placeHold'>;
