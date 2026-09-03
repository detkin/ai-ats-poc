/**
 * lib/adapters/bridge/index.ts — one import for the `TL_ADAPTER=bridge` port set (block B2.6).
 *
 * Owns: `buildBridgePorts`, which loads the imported Tier-1 tenant from
 * `TL_DATA_DIR/tier1` and hands it to **the fixture port classes, unchanged**. That is the
 * whole design: the bridge is a data path, not a second adapter family, so Graph, Ats, Bands,
 * Availability, Channel, State and Ledger behave identically on real people and on fixtures,
 * and the engine cannot tell which it is running over. Also owns `bridgeTier1Dir` and
 * `BridgeSnapshotMissingError`, the error a run gets when the data dir was never imported.
 *
 * Public interface: `buildBridgePorts`, `BridgeSnapshotMissingError`, `bridgeTier1Dir`, plus
 * the re-export surface of `snapshot.ts`, `map.ts` and `import.ts`.
 *
 * Spec: docs/PLAN.md §8; docs/DECISIONS.md D25–D27.
 */

import { join } from 'node:path';

import { buildFixturePorts } from '#lib/adapters/fixture/index.ts';
import { TIER1_DIRNAME, provenancePath } from '#lib/adapters/bridge/import.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import type { TenantPolicy } from '#lib/policy/index.ts';
import type { Ports } from '#lib/ports/index.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type { LoopStates } from '#lib/states/index.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

export {
  READ_FUNCTIONS,
  SNAPSHOT_FILENAME,
  BridgeSnapshotInvalidError,
  validateSnapshot,
} from '#lib/adapters/bridge/snapshot.ts';
export type {
  BridgeCall,
  BridgeSnapshot,
  McpAbsence,
  McpDepartment,
  McpDirectReports,
  McpLeaveType,
  McpPerson,
  McpSearchEnvelope,
  McpTeam,
  McpTimeOffBalance,
  McpWorkLocation,
  SnapshotValidation,
} from '#lib/adapters/bridge/snapshot.ts';
export {
  BRIDGE_PERMISSION,
  MANAGER_LEVEL_ID,
  MAPPING_VERSION,
  UNASSIGNED_DEPARTMENT_ID,
  UNASSIGNED_LOCATION_ID,
  UNKNOWN_LEAVE_TYPE_ID,
  UNKNOWN_LEVEL_ID,
  jobFunctionForDepartment,
  mapSnapshot,
} from '#lib/adapters/bridge/map.ts';
export type { MapResult, Provenance } from '#lib/adapters/bridge/map.ts';
export {
  PROVENANCE_FILE,
  TIER1_DIRNAME,
  importSnapshot,
  provenancePath,
  readProvenance,
  readSnapshotFile,
} from '#lib/adapters/bridge/import.ts';
export type { ImportResult } from '#lib/adapters/bridge/import.ts';

/** `<TL_DATA_DIR>/tier1` — where an imported tenant's Tier-1 JSON lives. */
export function bridgeTier1Dir(dataDir: string): string {
  return join(dataDir, TIER1_DIRNAME);
}

/** `TL_ADAPTER=bridge` with nothing imported into `TL_DATA_DIR`. */
export class BridgeSnapshotMissingError extends TalentLoopsError {
  readonly dataDir: string;

  constructor(dataDir: string) {
    super(
      'BRIDGE_SNAPSHOT_MISSING',
      `TL_ADAPTER=bridge but there is no imported tenant at ${provenancePath(dataDir)}. ` +
        'Fetch one with the calls printed by `node bin/bridge.mjs fetch-plan`, then run: ' +
        'node bin/bridge.mjs import --from <snapshot.json>',
    );
    this.name = 'BridgeSnapshotMissingError';
    this.dataDir = dataDir;
  }
}

export interface BridgePortsOptions {
  /** `TL_DATA_DIR`: holds `tier1/`, `state/`, `ledger.jsonl`, `outbox.jsonl`. */
  dataDir: string;
  actorWorkerId: WorkerId;
  policy: TenantPolicy;
  now: () => Date;
  states?: LoopStates;
  /** The already-loaded imported tenant. */
  bundle: TenantBundle;
}

/**
 * The bridge port set: the fixture adapters, pointed at the imported tenant.
 * `fixturesDir` is `TL_DATA_DIR/tier1` so `AtsPort.readDocument` and the (empty) calendar
 * fixture resolve inside the imported tenant rather than the committed one.
 */
export function buildBridgePorts(options: BridgePortsOptions): Ports {
  return buildFixturePorts({
    fixturesDir: bridgeTier1Dir(options.dataDir),
    dataDir: options.dataDir,
    actorWorkerId: options.actorWorkerId,
    policy: options.policy,
    now: options.now,
    bundle: options.bundle,
    ...(options.states === undefined ? {} : { states: options.states }),
  });
}
