/**
 * lib/fixtures/gen/bundle.ts — the shape of a generated tenant and the file names it maps to.
 *
 * Owns: `TenantBundle` (one array per Tier-1 file, the résumé corpus, and the seeded
 * Tier-2/3 state), the JSON file-name maps used by the writer, the loader and the manifest,
 * and the fixture anchor constants.
 *
 * Public interface: `TenantBundle`, `TenantState`, `TIER1_FILES`, `STATE_FILE_BY_KIND`,
 * `STATE_FILES`, `emptyState`, `ANCHOR_NOW`, `ANCHOR_DATE`, `GENERATOR_VERSION`,
 * `DEFAULT_SEED`, `EMAIL_DOMAIN`.
 *
 * Note (deviation from docs/PLAN.md §2.8): state files are the *plural* of the `StateKind`
 * discriminator — `state/cycles.json` holds `kind: 'cycle'` records — matching the explicit
 * file list in the B0.4 brief. `STATE_FILE_BY_KIND` is the single place that mapping lives,
 * so the fixture State adapter (block B1.2) should import it rather than re-derive it.
 *
 * Spec: docs/SPEC.md §3, §6; docs/PLAN.md §0 (anchor), §2.1, §2.7, §2.8.
 */

import type { StateKind } from '#lib/types/engine.ts';
import type {
  Absence,
  Application,
  Candidate,
  CompBand,
  Department,
  HeadcountPosition,
  Holiday,
  Identity,
  JobRequisition,
  LeaveType,
  Level,
  Location,
  PriorRating,
  Team,
  Worker,
} from '#lib/types/tier1.ts';
import type {
  TlAnomaly,
  TlCycle,
  TlInterviewSlot,
  TlMatch,
  TlNudge,
  TlPacket,
  TlProposedAction,
  TlReviewSubmission,
  TlScorecard,
  TlTask,
} from '#lib/types/engine.ts';

/** Frozen "now" every fixture date is written relative to (docs/PLAN.md §0). */
export const ANCHOR_NOW = '2026-09-02T16:00:00Z';
/** The calendar date of `ANCHOR_NOW` (UTC). */
export const ANCHOR_DATE = '2026-09-02';
/** Bumped whenever the generator's output changes shape; recorded in the manifest. */
export const GENERATOR_VERSION = '0.1.0';
/** Default seed. `generateTenant()` with no argument produces the committed fixtures. */
export const DEFAULT_SEED = 20260902;
/** Reserved example domain, so no fixture address can reach a real inbox. */
export const EMAIL_DOMAIN = 'acme-robotics.example';

/** Tier-2/3 records seeded into `fixtures/tenant/state/`. All but `cycles` start empty. */
export interface TenantState {
  cycles: TlCycle[];
  tasks: TlTask[];
  nudges: TlNudge[];
  packets: TlPacket[];
  proposed_actions: TlProposedAction[];
  matches: TlMatch[];
  interview_slots: TlInterviewSlot[];
  scorecards: TlScorecard[];
  review_submissions: TlReviewSubmission[];
  anomalies: TlAnomaly[];
}

/** Everything `generateTenant` produces and `loadTenant` returns. */
export interface TenantBundle {
  workers: Worker[];
  departments: Department[];
  teams: Team[];
  levels: Level[];
  locations: Location[];
  comp_bands: CompBand[];
  headcount_positions: HeadcountPosition[];
  job_requisitions: JobRequisition[];
  candidates: Candidate[];
  applications: Application[];
  absences: Absence[];
  leave_types: LeaveType[];
  holidays: Holiday[];
  prior_ratings: PriorRating[];
  identities: Identity[];
  /** `resume_ref` (e.g. `resumes/cand_0001.md`) → markdown body. Untrusted content. */
  resumes: Record<string, string>;
  state: TenantState;
}

/** Bundle key → file name under the fixtures dir. Order fixes the manifest key order. */
export const TIER1_FILES = {
  levels: 'levels.json',
  locations: 'locations.json',
  departments: 'departments.json',
  teams: 'teams.json',
  workers: 'workers.json',
  comp_bands: 'comp_bands.json',
  headcount_positions: 'headcount_positions.json',
  job_requisitions: 'job_requisitions.json',
  candidates: 'candidates.json',
  applications: 'applications.json',
  leave_types: 'leave_types.json',
  absences: 'absences.json',
  holidays: 'holidays.json',
  prior_ratings: 'prior_ratings.json',
  identities: 'identities.json',
} as const;

export type Tier1FileKey = keyof typeof TIER1_FILES;

/** `StatePort` kind → the JSON file that holds those records. */
export const STATE_FILE_BY_KIND: Record<StateKind, keyof TenantState> = {
  cycle: 'cycles',
  task: 'tasks',
  nudge: 'nudges',
  packet: 'packets',
  proposed_action: 'proposed_actions',
  match: 'matches',
  interview_slot: 'interview_slots',
  scorecard: 'scorecards',
  review_submission: 'review_submissions',
  anomaly: 'anomalies',
};

/** State bundle key → file name relative to the fixtures dir. */
export const STATE_FILES: Record<keyof TenantState, string> = {
  cycles: 'state/cycles.json',
  tasks: 'state/tasks.json',
  nudges: 'state/nudges.json',
  packets: 'state/packets.json',
  proposed_actions: 'state/proposed_actions.json',
  matches: 'state/matches.json',
  interview_slots: 'state/interview_slots.json',
  scorecards: 'state/scorecards.json',
  review_submissions: 'state/review_submissions.json',
  anomalies: 'state/anomalies.json',
};

/** The append-only ledger, empty in the seed (docs/PLAN.md §2.8). */
export const LEDGER_FILE = 'state/ledger.jsonl';

/** The manifest itself is never listed inside the manifest. */
export const MANIFEST_FILE = 'manifest.json';

export function emptyState(): TenantState {
  return {
    cycles: [],
    tasks: [],
    nudges: [],
    packets: [],
    proposed_actions: [],
    matches: [],
    interview_slots: [],
    scorecards: [],
    review_submissions: [],
    anomalies: [],
  };
}
