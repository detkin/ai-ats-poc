/**
 * lib/adapters/fixture/index.ts — the seven fixture ports, built once.
 *
 * Owns: `buildFixturePorts`, which loads the tenant bundle exactly once and hands the same
 * instance to the Graph, Ats, Bands and Availability adapters, plus the re-export surface for
 * every fixture adapter and error. Nothing here is ledgered: `lib/adapters/index.ts` wraps
 * the result before any caller sees it.
 *
 * Public interface: `buildFixturePorts`, `FixturePortsOptions`, and re-exports of the seven
 * adapters and their errors.
 *
 * Spec: docs/SPEC.md §2 (adapter pattern), §9; docs/PLAN.md §2.3, §2.8, §4 block B1.2.
 */

import { FixtureAtsAdapter } from '#lib/adapters/fixture/ats.ts';
import { FixtureAvailabilityAdapter } from '#lib/adapters/fixture/availability.ts';
import { FixtureBandsAdapter } from '#lib/adapters/fixture/bands.ts';
import { FixtureChannelAdapter } from '#lib/adapters/fixture/channel.ts';
import { FixtureGraphAdapter } from '#lib/adapters/fixture/graph.ts';
import { FixtureLedgerAdapter } from '#lib/adapters/fixture/ledger.ts';
import { FixtureStateAdapter } from '#lib/adapters/fixture/state.ts';
import { loadTenant } from '#lib/fixtures/index.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { TenantPolicy } from '#lib/policy/index.ts';
import type { Ports } from '#lib/ports/index.ts';
import type { LoopStates } from '#lib/states/index.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

export { FixtureAtsAdapter, DocumentNotFoundError } from '#lib/adapters/fixture/ats.ts';
export {
  FixtureAvailabilityAdapter,
  NotImplementedYetError,
  localParts,
} from '#lib/adapters/fixture/availability.ts';
export type { LocalParts } from '#lib/adapters/fixture/availability.ts';
export { FixtureBandsAdapter, compaRatio } from '#lib/adapters/fixture/bands.ts';
export {
  FixtureChannelAdapter,
  INBOX_FILENAME,
  OUTBOX_FILENAME,
} from '#lib/adapters/fixture/channel.ts';
export type { InboxLine, OutboxLine } from '#lib/adapters/fixture/channel.ts';
export { ActorNotFoundError, FixtureGraphAdapter } from '#lib/adapters/fixture/graph.ts';
export {
  FixtureLedgerAdapter,
  LEDGER_FILENAME,
  appendJsonLine,
  newId,
  randomHex,
  readJsonLines,
  toInstant,
  writeJsonAtomic,
} from '#lib/adapters/fixture/ledger.ts';
export {
  FixtureStateAdapter,
  ImmutableFieldError,
  RuntimeStateMissingError,
  STATE_DIRNAME,
  StateRecordNotFoundError,
  machineForKind,
} from '#lib/adapters/fixture/state.ts';

export interface FixturePortsOptions {
  /** Read-only Tier-1 seed directory (`TL_FIXTURES_DIR`). */
  fixturesDir: string;
  /** Runtime state, ledger, outbox and locks (`TL_DATA_DIR`). */
  dataDir: string;
  /** Worker id the agent acts as. */
  actorWorkerId: WorkerId;
  /** Tenant policy — the Availability adapter reads `quiet_hours` from it. */
  policy: TenantPolicy;
  /** The (frozen) clock. Every timestamp the adapters write comes from here. */
  now: () => Date;
  /** Pre-loaded states contract; omit to let `lib/states` load the default file. */
  states?: LoopStates;
  /** Pre-loaded tenant bundle; omit to `loadTenant(fixturesDir)` once, here. */
  bundle?: TenantBundle;
}

/**
 * Build the seven fixture ports. The tenant bundle is loaded once per call and shared, so a
 * tick that reads the org chart repeatedly touches the disk once.
 */
export function buildFixturePorts(options: FixturePortsOptions): Ports {
  const bundle = options.bundle ?? loadTenant(options.fixturesDir);
  return {
    graph: new FixtureGraphAdapter(bundle, options.actorWorkerId),
    ats: new FixtureAtsAdapter(bundle, options.fixturesDir),
    bands: new FixtureBandsAdapter(bundle),
    availability: new FixtureAvailabilityAdapter(bundle, options.policy),
    channel: new FixtureChannelAdapter(options.dataDir, options.actorWorkerId, options.now),
    state: new FixtureStateAdapter(
      options.dataDir,
      options.actorWorkerId,
      options.now,
      options.states,
    ),
    ledger: new FixtureLedgerAdapter(options.dataDir, options.now),
  };
}
