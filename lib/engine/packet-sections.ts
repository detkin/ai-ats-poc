/**
 * lib/engine/packet-sections.ts — the calibration packet's sections (a split of packet.ts).
 *
 * Owns: `CitationBook` (the accumulator that keeps the body and the stored citations in
 * step) and one function per section of the packet, each returning markdown lines. Nothing
 * here reads the world: every function takes the records it needs.
 *
 * Public interface: `CitationBook`, `ratingsByManager`, `compaRatios`, `completionRows`,
 * `headerSection`, `distributionSection`, `bandSection`, `tenureSection`,
 * `completionSection`, `observationsSection`, and the row types they return.
 *
 * The document contract those functions honour (asserted in `tests/engine/packet.test.ts`):
 * every line that states a figure ends with at least one `[kind:id,...]` token; headings,
 * table rules and the preamble before section 1 are the only lines allowed to carry a
 * number without one.
 *
 * Spec: docs/SPEC.md §8 loop 1, §10; docs/PLAN.md §4 block B1.1.
 */

import { daysBetween } from '#lib/engine/time.ts';
import type { CalibrationInputs } from '#lib/engine/packet.ts';
import type { TlCitation, TlReviewSubmission } from '#lib/types/engine.ts';
import type { InstantISO, PriorRating, Worker, WorkerId } from '#lib/types/tier1.ts';

/* ------------------------------------------------------------------ citation */

/** Accumulates citations while the body is being written, so the two cannot drift. */
export class CitationBook {
  private readonly entries: TlCitation[] = [];

  /**
   * Record a claim and return its inline token(s).
   * @param anchors the `kind:id` pairs shown inline.
   * @param all every record behind the claim; defaults to the anchors.
   */
  add(
    claimId: string,
    kind: 'source' | 'derived',
    anchors: [string, string[]][],
    all?: string[],
  ): string {
    const anchorIds = anchors.flatMap(([k, ids]) => ids.map((id) => `${k}:${id}`));
    const recordIds = [...new Set(all ?? anchorIds)].sort();
    this.entries.push({ claim_id: claimId, record_ids: recordIds, kind });
    return anchors
      .filter(([, ids]) => ids.length > 0)
      .map(([k, ids]) => `[${k}:${ids.join(',')}]`)
      .join('');
  }

  list(): TlCitation[] {
    return this.entries;
  }
}

/* -------------------------------------------------------------------- maths */

function round(value: number, places: number): string {
  return value.toFixed(places);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function sortIds(ids: string[]): string[] {
  return [...ids].sort();
}

export interface CompaRow {
  worker_id: WorkerId;
  band_id: string;
  compa_ratio: number;
  below_min: boolean;
  above_max: boolean;
}

/** Resolve each worker's band and compa-ratio. Workers without a band are simply absent. */
export function compaRatios(inputs: CalibrationInputs): Map<WorkerId, CompaRow> {
  const locationGroup = new Map(inputs.locations.map((l) => [l.id, l.location_group]));
  const knownLevels = new Set(inputs.levels.map((l) => l.id));
  const bandKey = (levelId: string, fn: string, group: string): string =>
    `${levelId}|${fn}|${group}`;
  const bands = new Map(
    inputs.bands.map((b) => [bandKey(b.level_id, b.job_function, b.location_group), b]),
  );

  const rows = new Map<WorkerId, CompaRow>();
  for (const worker of inputs.workers) {
    if (!knownLevels.has(worker.level_id)) continue;
    const group = locationGroup.get(worker.location_id);
    if (group === undefined) continue;
    const band = bands.get(bandKey(worker.level_id, worker.job_function, group));
    // No `compensation` at all means a bridged tenant: the MCP redacts pay (docs/PLAN.md §8).
    const compensation = worker.compensation;
    if (compensation === undefined) continue;
    if (band === undefined || band.currency !== compensation.currency) continue;
    const base = compensation.base_annual;
    rows.set(worker.id, {
      worker_id: worker.id,
      band_id: band.id,
      compa_ratio: band.mid === 0 ? 0 : base / band.mid,
      below_min: base < band.min,
      above_max: base > band.max,
    });
  }
  return rows;
}

const TENURE_BUCKETS = [
  { label: 'under 1 year', min: 0, max: 1 },
  { label: '1 to 2 years', min: 1, max: 2 },
  { label: '2 to 4 years', min: 2, max: 4 },
  { label: '4 years or more', min: 4, max: Number.POSITIVE_INFINITY },
] as const;

function tenureYears(worker: Worker, now: InstantISO): number {
  return daysBetween(`${worker.start_date}T00:00:00Z`, now) / 365.25;
}

/* ------------------------------------------------------------------ sections */

export function headerSection(inputs: CalibrationInputs): string[] {
  return [
    `# Calibration packet — ${inputs.cycle.name}`,
    '',
    '**AI involvement.** An automated agent assembled this packet from records in the HRIS.',
    'It contains no rating, no ranking and no recommendation. Every figure below is either a',
    'direct read of a record or an arithmetic aggregate over records, and each one names the',
    'records it came from. Decisions of record are made by named humans in the calibration',
    'meeting, and this document is an input to that conversation, not a substitute for it.',
    '',
    '**How to read this.** A `[<kind>:<id>, …]` token after a figure names the records behind',
    'it, and the same records are stored with the packet as structured citations.',
    'Where a figure aggregates more records than fit inline, the token names the anchor records',
    'and the packet’s stored citations carry the full list. Workers appear as record ids.',
    'Compensation appears only as a compa-ratio against the band midpoint; no pay amounts and',
    'no email addresses appear anywhere in this packet.',
    '',
    `Cycle \`${inputs.cycle.id}\` · owner \`${inputs.cycle.owner_worker_id}\` · assembled ${inputs.now}`,
    '',
  ];
}

export interface ManagerRating {
  manager_id: WorkerId;
  subjects: WorkerId[];
  ratings: number[];
  histogram: number[];
  mean: number;
}

export function ratingsByManager(inputs: CalibrationInputs): ManagerRating[] {
  const grouped = new Map<WorkerId, PriorRating[]>();
  for (const rating of inputs.prior_ratings) {
    const list = grouped.get(rating.rated_by_worker_id);
    if (list === undefined) grouped.set(rating.rated_by_worker_id, [rating]);
    else list.push(rating);
  }
  return [...grouped.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([managerId, list]) => {
      const sorted = [...list].sort((a, b) => (a.worker_id < b.worker_id ? -1 : 1));
      const histogram = [0, 0, 0, 0, 0];
      for (const r of sorted) {
        const index = Math.min(5, Math.max(1, Math.round(r.rating))) - 1;
        histogram[index] = (histogram[index] ?? 0) + 1;
      }
      return {
        manager_id: managerId,
        subjects: sorted.map((r) => r.worker_id),
        ratings: sorted.map((r) => r.rating),
        histogram,
        mean: mean(sorted.map((r) => r.rating)),
      };
    });
}

export function distributionSection(
  inputs: CalibrationInputs,
  rows: ManagerRating[],
  book: CitationBook,
): string[] {
  const cycleName = inputs.prior_ratings[0]?.cycle_name ?? 'prior cycle';
  const lines = [
    `## 1. Rating distribution by manager — source: prior_ratings, ${cycleName}`,
    '',
    'That table is the only rating data the system holds: the current cycle has produced',
    'none, and the engine never writes a rating.',
    '',
    '| Manager | Rated reports | Mean | one | two | three | four | five | Records |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    const token = book.add(
      `dist.${row.manager_id}`,
      'derived',
      [['prior_ratings', row.subjects]],
      row.subjects.map((id) => `prior_ratings:${id}`),
    );
    lines.push(
      `| \`${row.manager_id}\` | ${row.ratings.length} | ${round(row.mean, 2)} | ` +
        `${row.histogram.join(' | ')} | ${token} |`,
    );
  }

  const all = inputs.prior_ratings.map((r) => r.rating);
  const managers = rows.map((r) => r.manager_id);
  const companyToken = book.add(
    'dist.company',
    'derived',
    [['workers', managers]],
    inputs.prior_ratings.map((r) => `prior_ratings:${r.worker_id}`),
  );
  lines.push(
    '',
    `Company mean across ${all.length} rated workers and ${rows.length} managers: ` +
      `${round(mean(all), 2)}. ${companyToken}`,
    '',
  );
  return lines;
}

export function bandSection(
  inputs: CalibrationInputs,
  compa: Map<WorkerId, CompaRow>,
  book: CitationBook,
): string[] {
  // A tenant with no comp bands at all is a bridged one — the Rippling MCP redacts pay and
  // bands are REST-only (docs/PLAN.md §8, docs/testing/live-rippling.md). Say so, once, and
  // cite nothing: a table of zeroes would read as "everybody is at 0.000 of band".
  if (inputs.bands.length === 0) {
    const token = book.add('band.unavailable', 'derived', [['cycles', [inputs.cycle.id]]]);
    return [
      '## 2. Compa-ratio against band, by department',
      '',
      `Compensation not available via MCP ${token}`,
      '',
      'The Rippling MCP redacts pay and compensation bands are REST-only, so this run read',
      'no salary and no band for anybody. No compa-ratio is stated here, and none is implied.',
      '',
    ];
  }

  const lines = [
    '## 2. Compa-ratio against band, by department',
    '',
    'Compa-ratio is base pay divided by the midpoint of the worker’s comp band',
    '(level × job function × location group). Pay amounts are deliberately not shown.',
    '',
    '| Department | Workers with a band | Mean compa-ratio | Below min | Above max | Workers outside band | Records |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  const departments = sortIds([...new Set(inputs.workers.map((w) => w.department_id))]);
  for (const departmentId of departments) {
    const members = inputs.workers.filter((w) => w.department_id === departmentId);
    const rows = members.map((w) => compa.get(w.id)).filter((r): r is CompaRow => r !== undefined);
    const below = sortIds(rows.filter((r) => r.below_min).map((r) => r.worker_id));
    const above = sortIds(rows.filter((r) => r.above_max).map((r) => r.worker_id));
    const outside = [...below, ...above];
    const bandIds = sortIds([...new Set(rows.map((r) => r.band_id))]);
    const token = book.add(
      `band.${departmentId}`,
      'derived',
      [
        ['departments', [departmentId]],
        ['workers', outside],
      ],
      [
        `departments:${departmentId}`,
        ...rows.map((r) => `workers:${r.worker_id}`),
        ...bandIds.map((id) => `comp_bands:${id}`),
      ],
    );
    lines.push(
      `| \`${departmentId}\` | ${rows.length} | ${round(mean(rows.map((r) => r.compa_ratio)), 3)} | ` +
        `${below.length} | ${above.length} | ` +
        `${outside.length === 0 ? '—' : outside.map((id) => `\`${id}\``).join(' ')} | ${token} |`,
    );
  }
  lines.push('');
  return lines;
}

export function tenureSection(inputs: CalibrationInputs, book: CitationBook): string[] {
  const lines = [
    '## 3. Tenure of participants',
    '',
    'Tenure is measured from each worker’s `start_date` to the assembly time in the header.',
    '',
    '| Tenure | Participants | Records |',
    '| --- | --- | --- |',
  ];
  for (const bucket of TENURE_BUCKETS) {
    const members = inputs.workers.filter((w) => {
      const years = tenureYears(w, inputs.now);
      return years >= bucket.min && years < bucket.max;
    });
    const ids = sortIds(members.map((w) => w.id));
    const token = book.add(
      `tenure.${bucket.min}`,
      'derived',
      [['cycles', [inputs.cycle.id]]],
      [`cycles:${inputs.cycle.id}`, ...ids.map((id) => `workers:${id}`)],
    );
    lines.push(`| ${bucket.label} | ${members.length} | ${token} |`);
  }
  lines.push('');
  return lines;
}

export interface CompletionRow {
  manager_id: WorkerId | 'unassigned';
  total: number;
  submitted: number;
  submission_ids: string[];
}

export function completionRows(inputs: CalibrationInputs): CompletionRow[] {
  const managerOf = new Map(inputs.workers.map((w) => [w.id, w.manager_id]));
  const grouped = new Map<string, TlReviewSubmission[]>();
  for (const submission of inputs.submissions) {
    if (submission.cycle_id !== inputs.cycle.id) continue;
    const manager = managerOf.get(submission.author_worker_id) ?? null;
    const key = manager ?? 'unassigned';
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [submission]);
    else list.push(submission);
  }
  return [...grouped.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([managerId, list]) => ({
      manager_id: managerId,
      total: list.length,
      submitted: list.filter((s) => s.status === 'submitted').length,
      submission_ids: sortIds(list.map((s) => s.id)),
    }));
}

export function completionSection(
  rows: CompletionRow[],
  cycleId: string,
  book: CitationBook,
): string[] {
  const lines = [
    '## 4. Submission completion by manager',
    '',
    'Reviews owed by each manager’s own reports, and how many have arrived. A pending',
    'review is a scheduling fact, not a statement about the person who owes it.',
    '',
    '| Manager | Reviews owed | Submitted | Outstanding | Records |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const unassigned = row.manager_id === 'unassigned';
    const anchors: [string, string[]][] = unassigned
      ? [['cycles', [cycleId]]]
      : [['workers', [row.manager_id]]];
    const token = book.add(
      `completion.${row.manager_id}`,
      'derived',
      anchors,
      row.submission_ids.map((id) => `review_submissions:${id}`),
    );
    const label = unassigned ? 'no manager on record' : `\`${row.manager_id}\``;
    lines.push(
      `| ${label} | ${row.total} | ${row.submitted} | ${row.total - row.submitted} | ${token} |`,
    );
  }
  lines.push('');
  return lines;
}

export function observationsSection(
  inputs: CalibrationInputs,
  ratings: ManagerRating[],
  compa: Map<WorkerId, CompaRow>,
  completion: CompletionRow[],
  book: CitationBook,
): string[] {
  const lines = [
    '## 5. Observations',
    '',
    'Statements of fact drawn from the tables above, offered for discussion. None of them is',
    'a conclusion about any person.',
    '',
  ];

  const companyMean = mean(inputs.prior_ratings.map((r) => r.rating));
  const outliers = ratings.filter(
    (row) => row.ratings.length >= 4 && Math.abs(row.mean - companyMean) >= 1,
  );
  for (const row of outliers) {
    const token = book.add(
      `obs.distribution.${row.manager_id}`,
      'derived',
      [['prior_ratings', row.subjects]],
      row.subjects.map((id) => `prior_ratings:${id}`),
    );
    const direction = row.mean > companyMean ? 'above' : 'below';
    lines.push(
      `- Manager \`${row.manager_id}\` has a prior-cycle mean of ${round(row.mean, 2)} across ` +
        `${row.ratings.length} rated reports, ${round(Math.abs(row.mean - companyMean), 2)} ` +
        `${direction} the company mean of ${round(companyMean, 2)}. ${token}`,
    );
  }
  if (outliers.length === 0) {
    const token = book.add('obs.distribution.none', 'derived', [['cycles', [inputs.cycle.id]]]);
    lines.push(
      `- No manager with 4 or more rated reports differs from the company mean of ` +
        `${round(companyMean, 2)} by 1.00 or more. ${token}`,
    );
  }

  const outside = [...compa.values()].filter((r) => r.below_min || r.above_max);
  const belowIds = sortIds(outside.filter((r) => r.below_min).map((r) => r.worker_id));
  const aboveIds = sortIds(outside.filter((r) => r.above_max).map((r) => r.worker_id));
  const bandToken = book.add(
    'obs.band',
    'derived',
    [['workers', [...belowIds, ...aboveIds]]],
    [...belowIds, ...aboveIds].map((id) => `workers:${id}`),
  );
  lines.push(
    `- ${belowIds.length} participants sit below their band minimum and ${aboveIds.length} above ` +
      `their band maximum, out of ${compa.size} with a band on record. ${bandToken}`,
  );

  const withWork = completion.filter((row) => row.total > 0);
  const complete = withWork.filter((row) => row.submitted === row.total).length;
  const none = withWork.filter((row) => row.submitted === 0).length;
  const completionToken = book.add(
    'obs.completion',
    'derived',
    [['cycles', [inputs.cycle.id]]],
    withWork.flatMap((row) => row.submission_ids.map((id) => `review_submissions:${id}`)),
  );
  lines.push(
    `- Of ${withWork.length} managers with reviews owed by their reports, ${complete} have every ` +
      `review in and ${none} have none in yet. ${completionToken}`,
    '',
  );
  return lines;
}
