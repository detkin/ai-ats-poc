/**
 * lib/adapters/index.ts — `buildRuntime`: one call, everything a CLI needs.
 *
 * Owns: the composition root. It resolves the acting identity, loads the tenant policy and
 * the states contract, builds the port set for `config.adapter`, and returns them twice:
 *
 *   runtime.ports  — ledgered and allowlist-checked. Everything the engine and the CLIs use.
 *   runtime.raw    — the same ports, unwrapped. For read-only reconciliation (verify-loops,
 *                    audit) where ledgering the audit would bury the thing being audited.
 *
 * Availability is composed in both modes (block B2.1): Rippling absence is authoritative and
 * the Google Calendar free/busy signal sits behind it — the fixture calendar on fixtures, the
 * not-connected stub on `rippling`. A caller therefore cannot reach a calendar without the
 * absence check in front of it (spec §4).
 *
 * Acting identity (spec §9, docs/QUESTIONS.md Q1): `TL_ACTOR` when set, otherwise the
 * `is_default` row in the fixture tenant's `identities.json` (the HRBP). Permissions come
 * from that identity and land in `permission_context` on every ledger line. The engine never
 * elevates: there is no "system" actor anywhere in this file.
 *
 * Public interface: `Runtime`, `RuntimeOptions`, `buildRuntime`, `resolveActor`, plus the
 * re-export surface for the fixture adapters, the rippling stubs, the ledgered wrapper and
 * their error types.
 *
 * Spec: docs/SPEC.md §2, §5, §9; docs/PLAN.md §2.3, §2.8, §4 block B1.2.
 */

import { join } from 'node:path';

import {
  BridgeSnapshotMissingError,
  bridgeTier1Dir,
  buildBridgePorts,
  readProvenance,
} from '#lib/adapters/bridge/index.ts';
import { buildFixturePorts } from '#lib/adapters/fixture/index.ts';
import { ActorNotFoundError } from '#lib/adapters/fixture/graph.ts';
import { ledgered } from '#lib/adapters/ledgered.ts';
import { GcalStubAdapter } from '#lib/adapters/gcal/index.ts';
import { buildRipplingPorts } from '#lib/adapters/rippling/index.ts';
import { composeAvailability } from '#lib/availability/compose.ts';
import { loadConfig, now as clockNow } from '#lib/config.ts';
import type { Config } from '#lib/config.ts';
import { loadTenant } from '#lib/fixtures/index.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import { POLICY_FILENAME, loadPolicy } from '#lib/policy/index.ts';
import type { TenantPolicy } from '#lib/policy/index.ts';
import type { ActorContext } from '#lib/ports/context.ts';
import type { Ports } from '#lib/ports/index.ts';
import { loadLoopStates } from '#lib/states/index.ts';
import type { LoopStates } from '#lib/states/index.ts';

export {
  BRIDGE_PERMISSION,
  BridgeSnapshotInvalidError,
  BridgeSnapshotMissingError,
  MANAGER_LEVEL_ID,
  MAPPING_VERSION,
  PROVENANCE_FILE,
  READ_FUNCTIONS,
  SNAPSHOT_FILENAME,
  TIER1_DIRNAME,
  UNASSIGNED_DEPARTMENT_ID,
  UNASSIGNED_LOCATION_ID,
  UNKNOWN_LEAVE_TYPE_ID,
  UNKNOWN_LEVEL_ID,
  bridgeTier1Dir,
  buildBridgePorts,
  importSnapshot,
  jobFunctionForDepartment,
  mapSnapshot,
  provenancePath,
  readProvenance,
  readSnapshotFile,
  validateSnapshot,
} from '#lib/adapters/bridge/index.ts';
export type {
  BridgeCall,
  BridgeSnapshot,
  ImportResult,
  MapResult,
  McpPerson,
  Provenance,
} from '#lib/adapters/bridge/index.ts';
export { buildFixturePorts } from '#lib/adapters/fixture/index.ts';
export type { FixturePortsOptions } from '#lib/adapters/fixture/index.ts';
export {
  ActorNotFoundError,
  DocumentNotFoundError,
  FixtureAtsAdapter,
  FixtureAvailabilityAdapter,
  FixtureBandsAdapter,
  FixtureChannelAdapter,
  FixtureGraphAdapter,
  FixtureLedgerAdapter,
  FixtureStateAdapter,
  INBOX_FILENAME,
  ImmutableFieldError,
  LEDGER_FILENAME,
  NotImplementedYetError,
  OUTBOX_FILENAME,
  RuntimeStateMissingError,
  STATE_DIRNAME,
  StateRecordNotFoundError,
  compaRatio,
  localParts,
  toInstant,
} from '#lib/adapters/fixture/index.ts';
export type { InboxLine, OutboxLine } from '#lib/adapters/fixture/index.ts';
export {
  MAX_ARGS_SUMMARY_CHARS,
  canonicalJson,
  defaultCycleIdOf,
  hashArgs,
  ledgered,
  summarizeArgs,
} from '#lib/adapters/ledgered.ts';
export type { LedgerContext } from '#lib/adapters/ledgered.ts';
export {
  CODEMODE_FUNCTIONS,
  RipplingNotConnectedError,
  buildRipplingPorts,
  codemode,
} from '#lib/adapters/rippling/index.ts';
export {
  CALENDAR_BUSY_FILE,
  GCAL_BACKING,
  GCAL_QUESTION_REF,
  GcalFixtureAdapter,
  GcalNotConnectedError,
  GcalStubAdapter,
  HOLDS_FILENAME,
  readCalendarBusy,
} from '#lib/adapters/gcal/index.ts';
export type { GcalFixtureOptions, HoldLine } from '#lib/adapters/gcal/index.ts';
export {
  AbsenceWinsError,
  MAX_CANDIDATE_SLOTS,
  SLOT_GRID_MINUTES,
  composeAvailability,
} from '#lib/availability/compose.ts';
export type { AbsenceAuthority, ComposeOptions } from '#lib/availability/compose.ts';

/** Everything one process needs to run a tick, built once. */
export interface Runtime {
  readonly config: Config;
  /** Who the agent is acting as. Copied into every ledger line. */
  readonly actor: ActorContext;
  readonly policy: TenantPolicy;
  readonly states: LoopStates;
  /** Ledgered, allowlist-checked ports. Use these. */
  readonly ports: Ports;
  /** Unledgered ports — read-only reconciliation and audit rendering only. */
  readonly raw: Ports;
  /** The (frozen) clock, as a fresh `Date` each call. */
  now(): Date;
  /** Correlates every ledger line written by one tick. */
  readonly tickId?: string;
  /** The fixture tenant, when running on fixtures — already loaded, share it. */
  readonly bundle?: TenantBundle;
}

export interface RuntimeOptions {
  /** Pre-loaded policy; omit to read `tenant/policy.yml` under `config.tenantDir`. */
  policy?: TenantPolicy;
  /** Pre-loaded states contract; omit to read `templates/loop-states.yml`. */
  states?: LoopStates;
  /** Tick correlation id; `bin/tick.mjs` passes one so every line of a tick is findable. */
  tickId?: string;
  /** Override how a call is mapped to a cycle for the ledger's `cycle_id`. */
  cycleIdOf?: (fn: string, args: unknown[]) => string | null;
}

/**
 * The acting identity for a fixture run: `TL_ACTOR`, else the `is_default` identity.
 * Throws `ActorNotFoundError` when `TL_ACTOR` names a worker the tenant does not have.
 */
export function resolveActor(bundle: TenantBundle, config: Config): ActorContext {
  const identity =
    config.actor === undefined
      ? (bundle.identities.find((row) => row.is_default) ?? bundle.identities[0])
      : bundle.identities.find((row) => row.worker_id === config.actor);
  const workerId = config.actor ?? identity?.worker_id;
  if (workerId === undefined) {
    throw new ActorNotFoundError('(no identity in identities.json)');
  }
  const worker = bundle.workers.find((row) => row.id === workerId);
  if (worker === undefined) throw new ActorNotFoundError(workerId);

  return {
    worker_id: worker.id,
    email: worker.work_email,
    permissions: identity === undefined ? [] : [...identity.permissions],
    adapter: config.adapter,
  };
}

/**
 * The imported tenant under `TL_DATA_DIR/tier1`, or `BridgeSnapshotMissingError` naming the
 * command that creates one. The provenance file is the marker: Tier-1 JSON alone could have
 * been copied in by hand, and a bridged run must be able to say where its data came from.
 */
function loadBridgeTenant(config: Config): TenantBundle {
  if (readProvenance(config.dataDir) === null) {
    throw new BridgeSnapshotMissingError(config.dataDir);
  }
  return loadTenant(bridgeTier1Dir(config.dataDir));
}

/**
 * The `rippling` port set, with availability composed over the not-connected calendar stub.
 * Every method still throws; the point is that the *shape* is the same in both modes, so a
 * caller cannot depend on a seam that only exists on fixtures.
 */
function ripplingPorts(): Ports {
  const ports = buildRipplingPorts();
  return {
    ...ports,
    availability: composeAvailability(ports.availability, new GcalStubAdapter()),
  };
}

/**
 * Build the runtime for `config.adapter`.
 *
 * ```ts
 * const runtime = buildRuntime();                       // TL_* environment
 * const runtime = buildRuntime(config, { tickId });     // one tick, correlated
 * await runtime.ports.state.create('task', { … });       // checked and ledgered
 * ```
 */
export function buildRuntime(config: Config = loadConfig(), options: RuntimeOptions = {}): Runtime {
  const policy = options.policy ?? loadPolicy(join(config.tenantDir, POLICY_FILENAME));
  const states = options.states ?? loadLoopStates();
  const now = (): Date => clockNow(config);

  // `bridge` loads the tenant the agent imported; `fixture` the committed one. Both then run
  // through the *same* fixture port classes — that is the point of the bridge (plan §8).
  const bundle =
    config.adapter === 'fixture'
      ? loadTenant(config.fixturesDir)
      : config.adapter === 'bridge'
        ? loadBridgeTenant(config)
        : undefined;
  const actor: ActorContext =
    bundle === undefined
      ? {
          worker_id: config.actor ?? 'unknown',
          email: '',
          permissions: [],
          adapter: config.adapter,
        }
      : resolveActor(bundle, config);

  const raw: Ports =
    bundle === undefined
      ? ripplingPorts()
      : config.adapter === 'bridge'
        ? buildBridgePorts({
            dataDir: config.dataDir,
            actorWorkerId: actor.worker_id,
            policy,
            now,
            bundle,
            states,
          })
        : buildFixturePorts({
            fixturesDir: config.fixturesDir,
            dataDir: config.dataDir,
            actorWorkerId: actor.worker_id,
            policy,
            now,
            bundle,
            states,
          });

  const ledgerContext = {
    actor,
    ledger: raw.ledger,
    now,
    ...(options.tickId === undefined ? {} : { tickId: options.tickId }),
    ...(options.cycleIdOf === undefined ? {} : { cycleIdOf: options.cycleIdOf }),
  };

  const ports: Ports = {
    graph: ledgered('graph', raw.graph, ledgerContext),
    ats: ledgered('ats', raw.ats, ledgerContext),
    bands: ledgered('bands', raw.bands, ledgerContext),
    availability: ledgered('availability', raw.availability, ledgerContext),
    channel: ledgered('channel', raw.channel, ledgerContext),
    state: ledgered('state', raw.state, ledgerContext),
    ledger: raw.ledger,
  };

  return {
    config,
    actor,
    policy,
    states,
    ports,
    raw,
    now,
    ...(options.tickId === undefined ? {} : { tickId: options.tickId }),
    ...(bundle === undefined ? {} : { bundle }),
  };
}
