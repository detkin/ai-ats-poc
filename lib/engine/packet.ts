/**
 * lib/engine/packet.ts — the calibration packet, assembled as a pure function.
 *
 * Owns: `assembleCalibration`, which turns a set of records into a markdown body, a list of
 * `TlCitation`s, and the `inputs_hash` that decides when the packet is stale (spec §7 step 2).
 * No LLM is involved: every figure is arithmetic over records, so the packet is reproducible
 * and gets a golden test (`evals/golden/calibration-h2-2026.md`).
 *
 * Public interface:
 *   assembleCalibration(inputs): { body_md, citations, inputs_hash }
 *   calibrationInputsHash(inputs): string     // what `planTick` compares against
 *   CalibrationInputs, CalibrationPacket
 *   FORBIDDEN_WORDS, findForbiddenWords(body), CITATION_TOKEN_RE
 *
 * Three invariants, all tested (spec §10, "judged, every packet"):
 *  1. **Faithfulness.** Every figure is followed by at least one `[kind:id,...]` citation
 *     token, and every token also appears in `citations`. Aggregates are `kind: 'derived'`,
 *     straight reads are `kind: 'source'`. Where a figure aggregates more records than fit
 *     inline, the token names the anchor records and the `citations` entry carries them all.
 *  2. **Neutrality.** No verdict language (`FORBIDDEN_WORDS`). The packet observes; the
 *     calibration meeting decides. No word in it rates anybody.
 *  3. **PII hygiene.** Workers appear as ids, never as names or email addresses, and
 *     compensation appears only as a compa-ratio against the band midpoint — never an amount.
 *
 * Ratings come from one place and are labelled as such: the prior cycle's `prior_ratings`
 * (Tier-1, read-only). The POC has no current-cycle ratings and the engine never writes one.
 *
 * The section renderers and the citation accumulator live in `lib/engine/packet-sections.ts`
 * to keep both files small; this module owns the inputs, the hash and the assembly order.
 *
 * Spec: docs/SPEC.md §7, §8 loop 1, §9, §10; docs/PLAN.md §4 block B1.1.
 */

import { sha256Hex } from '#lib/engine/hash.ts';
import {
  CitationBook,
  bandSection,
  compaRatios,
  completionRows,
  completionSection,
  distributionSection,
  headerSection,
  observationsSection,
  ratingsByManager,
  tenureSection,
} from '#lib/engine/packet-sections.ts';
import type { TlCitation, TlCycle, TlReviewSubmission } from '#lib/types/engine.ts';
import type {
  CompBand,
  InstantISO,
  Level,
  Location,
  PriorRating,
  Worker,
} from '#lib/types/tier1.ts';

/** Everything the calibration packet is allowed to read. All Tier-1 except `submissions`. */
export interface CalibrationInputs {
  cycle: TlCycle;
  /** The cycle's participants (already scoped). */
  workers: Worker[];
  levels: Level[];
  bands: CompBand[];
  /** Needed to resolve a worker's `location_group`, which keys the comp band. */
  locations: Location[];
  prior_ratings: PriorRating[];
  submissions: TlReviewSubmission[];
  now: InstantISO;
}

export interface CalibrationPacket {
  body_md: string;
  citations: TlCitation[];
  inputs_hash: string;
}

/** Verdict language a calibration packet may never contain (spec §10, neutrality). */
export const FORBIDDEN_WORDS = [
  'underperformer',
  'under-performer',
  'low performer',
  'top performer',
  'should be rated',
  'must',
  'fire',
  'promote',
  'demote',
  'terminate',
  'best',
  'worst',
] as const;

/** `[kind:id,id]` — the inline provenance token. */
export const CITATION_TOKEN_RE = /\[([a-z_]+):([^\]]+)\]/g;

/** Forbidden words present in a body, lower-cased, de-duplicated, in list order. */
export function findForbiddenWords(body: string): string[] {
  const haystack = body.toLowerCase();
  return FORBIDDEN_WORDS.filter((word) =>
    new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(haystack),
  );
}

/* ------------------------------------------------------------------- public */

/**
 * The canonical projection of the inputs that decides whether the packet is stale.
 * `now` is deliberately excluded: the clock moving is not a reason to reassemble.
 */
export function calibrationInputsHash(inputs: CalibrationInputs): string {
  return sha256Hex({
    cycle: { id: inputs.cycle.id, name: inputs.cycle.name, opened_at: inputs.cycle.opened_at },
    workers: [...inputs.workers]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((w) => [
        w.id,
        w.department_id,
        w.team_id,
        w.level_id,
        w.job_function,
        w.location_id,
        w.manager_id,
        w.start_date,
        w.status,
        w.compensation.base_annual,
        w.compensation.currency,
      ]),
    bands: [...inputs.bands]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((b) => [
        b.id,
        b.level_id,
        b.job_function,
        b.location_group,
        b.currency,
        b.min,
        b.mid,
        b.max,
      ]),
    locations: [...inputs.locations]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((l) => [l.id, l.location_group]),
    levels: [...inputs.levels].map((l) => l.id).sort(),
    prior_ratings: [...inputs.prior_ratings]
      .map((r) => [r.worker_id, r.cycle_name, r.rating, r.rated_by_worker_id])
      .sort((a, b) => (String(a) < String(b) ? -1 : 1)),
    submissions: [...inputs.submissions]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((s) => [s.id, s.cycle_id, s.subject_worker_id, s.author_worker_id, s.kind, s.status]),
  });
}

/**
 * Assemble the calibration packet. Deterministic: the same records and the same `now`
 * always produce byte-identical markdown, which is what makes the golden test meaningful.
 */
export function assembleCalibration(inputs: CalibrationInputs): CalibrationPacket {
  const book = new CitationBook();
  const ratings = ratingsByManager(inputs);
  const compa = compaRatios(inputs);
  const completion = completionRows(inputs);

  const body = [
    ...headerSection(inputs),
    ...distributionSection(inputs, ratings, book),
    ...bandSection(inputs, compa, book),
    ...tenureSection(inputs, book),
    ...completionSection(completion, inputs.cycle.id, book),
    ...observationsSection(inputs, ratings, compa, completion, book),
  ].join('\n');

  return {
    body_md: `${body.trimEnd()}\n`,
    citations: book.list(),
    inputs_hash: calibrationInputsHash(inputs),
  };
}
