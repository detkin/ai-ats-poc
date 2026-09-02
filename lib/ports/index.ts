/**
 * lib/ports/index.ts — the seven ports plus the actor context, in one import.
 *
 * Owns: the `Ports` bundle every adapter must satisfy and every engine caller receives.
 * Adding a port means adding a file here and a row to the write allowlist.
 *
 * Public interface: `Ports`, plus a re-export of every port type.
 *
 * Spec: docs/SPEC.md §5 (project shape); docs/PLAN.md §2.3.
 */

export type { ActorContext, AdapterMode } from '#lib/ports/context.ts';
export { ADAPTER_MODES } from '#lib/ports/context.ts';
export type { GraphPort, PeopleQuery } from '#lib/ports/graph.ts';
export type {
  ApplicationQuery,
  AtsPort,
  DraftHireInput,
  HeadcountPositionQuery,
  RequisitionInput,
  RequisitionQuery,
} from '#lib/ports/ats.ts';
export type { BandQuery, BandsPort, WorkerCompensation } from '#lib/ports/bands.ts';
export type {
  AbsenceAnswer,
  AvailabilityPort,
  HoldInput,
  HoldResult,
  QuietHoursAnswer,
  Slot,
  SlotQuery,
} from '#lib/ports/availability.ts';
export type {
  ChannelMessageInput,
  ChannelPort,
  DeliveryResult,
  DirectMessageInput,
  PostResult,
} from '#lib/ports/channel.ts';
export type { StateFilter, StatePort } from '#lib/ports/state.ts';
export type { LedgerPort, LedgerQuery } from '#lib/ports/ledger.ts';

import type { AtsPort } from '#lib/ports/ats.ts';
import type { AvailabilityPort } from '#lib/ports/availability.ts';
import type { BandsPort } from '#lib/ports/bands.ts';
import type { ChannelPort } from '#lib/ports/channel.ts';
import type { GraphPort } from '#lib/ports/graph.ts';
import type { LedgerPort } from '#lib/ports/ledger.ts';
import type { StatePort } from '#lib/ports/state.ts';

/** The complete port surface. `PortName` keys the write allowlist. */
export interface Ports {
  graph: GraphPort;
  ats: AtsPort;
  bands: BandsPort;
  availability: AvailabilityPort;
  channel: ChannelPort;
  state: StatePort;
  ledger: LedgerPort;
}

export type PortName = keyof Ports;
