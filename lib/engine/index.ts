/**
 * lib/engine/index.ts — one import for the cycle engine (block B1.1).
 *
 * Owns: nothing. It is the public surface of `lib/engine/*`: the CLIs (block B1.3) and the
 * M2 interview loop (block B2.1) import from here so the internals can be split further
 * without touching call sites.
 *
 * The engine is pure. Nothing under `lib/engine/` reads a file, a clock or an environment
 * variable: `now` arrives on the snapshot, records arrive on the snapshot, and the result is
 * a plan somebody else executes through the ports (spec §7, §9).
 *
 * Spec: docs/SPEC.md §7; docs/PLAN.md §4 block B1.1.
 */

export { applyPlan } from '#lib/engine/apply.ts';
export { detect, isRecipientInCycle } from '#lib/engine/detect.ts';
export { canonicalJson, sha256Hex, CanonicalJsonError } from '#lib/engine/hash.ts';
export {
  assembleCalibration,
  calibrationInputsHash,
  findForbiddenWords,
  CITATION_TOKEN_RE,
  FORBIDDEN_WORDS,
} from '#lib/engine/packet.ts';
export type { CalibrationInputs, CalibrationPacket } from '#lib/engine/packet.ts';
export {
  bundleTemplateId,
  nudgeTemplateId,
  planTick,
  policyCheckFor,
  tickId,
} from '#lib/engine/plan.ts';
export {
  participantsFor,
  peersFor,
  staggerDaysFor,
  submissionKindOfTask,
  submissionsFor,
  taskKindOfSubmission,
  tasksFor,
  REVIEW_TASK_KINDS,
} from '#lib/engine/review-cycle.ts';
export type { ReviewTaskKind } from '#lib/engine/review-cycle.ts';
export {
  addDays,
  daysBetween,
  dateOf,
  dueAtAfter,
  endOfDay,
  fullDaysBetween,
  hoursBetween,
  parseInstant,
  EngineTimeError,
  MS_PER_DAY,
} from '#lib/engine/time.ts';
export { PLANNED_ACTION_KINDS } from '#lib/engine/snapshot.ts';
export type {
  AnomalyFinding,
  AvailabilityAnswer,
  DetectSummary,
  LastTick,
  PlannedAction,
  PlannedActionKind,
  PlannedAnomaly,
  PlannedCloseCycle,
  PlannedCompleteTask,
  PlannedEscalate,
  PlannedMoveDueDate,
  PlannedNudge,
  PlannedNudgeTask,
  PlannedRefreshPacket,
  PlannedTransitionCycle,
  TaskSignal,
  TickPlan,
  TickSnapshot,
  UntrustedText,
} from '#lib/engine/snapshot.ts';
