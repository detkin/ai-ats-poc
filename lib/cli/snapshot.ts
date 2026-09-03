/**
 * lib/cli/snapshot.ts — reading the world for one tick, through the ports.
 *
 * Owns: the *only* place a `TickSnapshot` is assembled from live ports. The engine is pure
 * and takes a snapshot; this module does the reading — cycle, tasks, proposals, nudges,
 * shadow submissions, anomalies, a fresh re-read of every worker (spec §3: Tier-1 values are
 * re-read, never stored), and one absence + one quiet-hours answer per participant. Every
 * call goes through `rt.ports`, so the ledger records the reads a decision was made on, not
 * only the writes it produced.
 *
 * It also owns the two things the tick needs that are not records:
 *   - the calibration `inputs_hash` the engine compares against the newest stored packet, and
 *   - `<TL_DATA_DIR>/ticks/<cycle_id>.json`, the previous tick's task states. This file lives
 *     **outside** `state/` on purpose: it is scratch for the "diff vs last tick" step, not a
 *     `tl_*` object, so it is not ledgered, not audited and safe to delete.
 *
 * Public interface:
 *   buildSnapshot(rt, cycleId, options?) -> { snapshot, cycle, workers, participants, packets }
 *   loadCycle(rt, cycleId), calibrationInputsFor(rt, cycle, workers, submissions)
 *   readLastTick(config, cycleId), writeLastTick(config, cycleId, entry), ticksPathFor
 *   TICKS_DIRNAME, SnapshotResult, SnapshotOptions
 *
 * Spec: docs/SPEC.md §3, §4 (absence is authoritative), §7 step 1; docs/PLAN.md §4 block B1.3.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Runtime } from '#lib/adapters/index.ts';
import { CliError } from '#lib/cli/runtime.ts';
import type { Config } from '#lib/config.ts';
import { calibrationInputsHash, dateOf, participantsFor } from '#lib/engine/index.ts';
import type {
  AvailabilityAnswer,
  LastTick,
  TickSnapshot,
  UntrustedText,
} from '#lib/engine/index.ts';
import type { CalibrationInputs } from '#lib/engine/packet.ts';
import type {
  TlAnomaly,
  TlCycle,
  TlNudge,
  TlPacket,
  TlProposedAction,
  TlReviewSubmission,
  TlTask,
} from '#lib/types/engine.ts';
import type { InstantISO, Worker, WorkerId } from '#lib/types/tier1.ts';

/** Scratch directory for last-tick state, relative to `TL_DATA_DIR`. Not `tl_*` state. */
export const TICKS_DIRNAME = 'ticks';

export interface SnapshotOptions {
  /** Extra untrusted document refs to screen this tick (`tick.mjs --scan <ref>`). */
  scan?: readonly string[];
  /** Include `last_tick` from the ticks file. `false` for one-off reads like `nudge.mjs`. */
  withLastTick?: boolean;
}

export interface SnapshotResult {
  snapshot: TickSnapshot;
  cycle: TlCycle;
  workers: Map<WorkerId, Worker>;
  participants: Worker[];
  /** Calibration packets already on record for this cycle, oldest first. */
  packets: TlPacket[];
}

/** `<TL_DATA_DIR>/ticks/<cycle_id>.json`. */
export function ticksPathFor(config: Config, cycleId: string): string {
  return join(config.dataDir, TICKS_DIRNAME, `${cycleId}.json`);
}

/** What the previous tick left behind, or `undefined` when this is the first one. */
export function readLastTick(config: Config, cycleId: string): LastTick | undefined {
  const path = ticksPathFor(config, cycleId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const record = parsed as { at?: unknown; task_states?: unknown };
    if (typeof record.at !== 'string' || record.task_states === null) return undefined;
    return { at: record.at, task_states: (record.task_states ?? {}) as LastTick['task_states'] };
  } catch {
    // A corrupt scratch file means "no previous tick", never a failed tick.
    return undefined;
  }
}

/** Record this tick's task states for the next tick's diff. */
export function writeLastTick(
  config: Config,
  cycleId: string,
  entry: LastTick & { tick_id: string },
): void {
  const path = ticksPathFor(config, cycleId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
}

/** The cycle, or a `CliError` naming the id. */
export async function loadCycle(rt: Runtime, cycleId: string): Promise<TlCycle> {
  const cycle = await rt.ports.state.get('cycle', cycleId);
  if (cycle === null) {
    throw new CliError('CYCLE_NOT_FOUND', `no cycle with id "${cycleId}" in the runtime state.`);
  }
  return cycle;
}

/** Every worker, re-read this tick, keyed by id. */
export async function readWorkers(rt: Runtime): Promise<Map<WorkerId, Worker>> {
  const workers = await rt.ports.graph.searchPeople({});
  return new Map(workers.map((worker) => [worker.id, worker]));
}

/**
 * One absence answer and one quiet-hours answer per worker who owes something. Absence is
 * authoritative (spec §4): it is asked first and its answer is never overridden by a calendar.
 */
async function readAvailability(
  rt: Runtime,
  workerIds: readonly WorkerId[],
  now: InstantISO,
): Promise<Map<WorkerId, AvailabilityAnswer>> {
  const today = dateOf(now);
  const answers = new Map<WorkerId, AvailabilityAnswer>();
  for (const workerId of workerIds) {
    const absence = await rt.ports.availability.absenceOn(workerId, today);
    const quiet = await rt.ports.availability.quietHours(workerId, now);
    const answer: AvailabilityAnswer = { absent: absence.absent, quiet: quiet.quiet };
    if (absence.reason !== undefined) answer.reason = absence.reason;
    if (absence.until !== undefined) answer.until = absence.until;
    // Which authority answered: approved leave moves due dates, a holiday only silences.
    if (absence.absent) answer.source = absence.source;
    if (quiet.reason !== undefined) answer.quiet_reason = quiet.reason;
    answers.set(workerId, answer);
  }
  return answers;
}

/** Untrusted free text this tick read: submitted review bodies plus anything `--scan`ned. */
async function readUntrusted(
  rt: Runtime,
  submissions: readonly TlReviewSubmission[],
  scan: readonly string[],
): Promise<UntrustedText[]> {
  const refs = [
    ...new Set([
      ...submissions
        .filter((submission) => submission.body_ref !== null)
        .map((submission) => submission.body_ref as string),
      ...scan,
    ]),
  ].sort();

  const texts: UntrustedText[] = [];
  for (const ref of refs) {
    const document = await rt.ports.ats.readDocument(ref);
    texts.push({ source_ref: ref, text: document.text });
  }
  return texts;
}

/**
 * Everything the calibration packet is allowed to read, gathered through the ports.
 *
 * Known gap: `prior_ratings` has no port (`lib/ports/*` exposes Graph, Ats, Bands,
 * Availability, Channel, State, Ledger and none of them carries a rating). On fixtures they
 * come off the loaded tenant bundle; a Rippling adapter will need a Bands- or Graph-side
 * read before this works on a tenant. Recorded in `lib/cli/README.md`.
 */
export async function calibrationInputsFor(
  rt: Runtime,
  cycle: TlCycle,
  participants: Worker[],
  submissions: TlReviewSubmission[],
  now: InstantISO,
): Promise<CalibrationInputs> {
  const [levels, bands, locations] = [
    await rt.ports.graph.listLevels(),
    await rt.ports.bands.listBands(),
    await rt.ports.graph.listLocations(),
  ];
  return {
    cycle,
    workers: participants,
    levels,
    bands,
    locations,
    prior_ratings: rt.bundle?.prior_ratings ?? [],
    submissions,
    now,
  };
}

/** The newest calibration packet on record, by `created_at` then id. */
export function newestCalibrationPacket(packets: readonly TlPacket[]): TlPacket | undefined {
  return [...packets]
    .filter((packet) => packet.kind === 'calibration')
    .sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    )
    .at(-1);
}

/**
 * Read everything one tick may look at. Sequential on purpose: the ledger's line order is
 * then the order the tick actually asked its questions, which is what makes `audit.mjs`
 * readable and a golden ledger diff meaningful.
 */
export async function buildSnapshot(
  rt: Runtime,
  cycleId: string,
  now: InstantISO,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const cycle = await loadCycle(rt, cycleId);
  const filter = { cycle_id: cycleId } as const;
  const tasks: TlTask[] = await rt.ports.state.list('task', filter);
  const proposals: TlProposedAction[] = await rt.ports.state.list('proposed_action', filter);
  const nudges: TlNudge[] = await rt.ports.state.list('nudge', filter);
  const submissions: TlReviewSubmission[] = await rt.ports.state.list('review_submission', filter);
  const anomalies: TlAnomaly[] = await rt.ports.state.list('anomaly', filter);
  const packets: TlPacket[] = await rt.ports.state.list('packet', filter);

  const workers = await readWorkers(rt);
  const participants = participantsFor(cycle, workers);
  const owed = [...new Set(tasks.map((task) => task.participant_worker_id))].sort();
  const availability = await readAvailability(rt, owed, now);
  const untrusted = await readUntrusted(rt, submissions, options.scan ?? []);
  const departments = new Map((await rt.ports.graph.searchDepartments()).map((d) => [d.id, d]));

  const snapshot: TickSnapshot = {
    cycle,
    tasks,
    proposals,
    nudges,
    submissions,
    workers,
    availability,
    policy: rt.policy,
    now,
    actor_worker_id: rt.actor.worker_id,
    departments,
    untrusted,
    anomalies,
  };

  if (options.withLastTick !== false) {
    const last = readLastTick(rt.config, cycleId);
    if (last !== undefined) snapshot.last_tick = last;
  }

  if (cycle.type === 'review') {
    const inputs = await calibrationInputsFor(rt, cycle, participants, submissions, now);
    snapshot.calibration_inputs_hash = calibrationInputsHash(inputs);
    const newest = newestCalibrationPacket(packets);
    if (newest !== undefined) snapshot.last_packet_inputs_hash = newest.inputs_hash;
  }

  return { snapshot, cycle, workers, participants, packets };
}
