/**
 * lib/engine/packet-debrief.ts — the interview debrief packet, assembled as a pure function.
 *
 * Owns: `assembleDebrief`, which turns a panel's scorecards into a markdown body, a list of
 * `TlCitation`s, the `inputs_hash` that decides when the packet is stale, and the list of
 * anomalies found while reading untrusted text. No LLM is involved: the packet quotes what
 * interviewers wrote and counts what is on record, so it is reproducible and gets a golden
 * test (`evals/golden/debrief-req_staff_eng.md`).
 *
 * Public interface:
 *   assembleDebrief(inputs): { body_md, citations, inputs_hash, anomalies }
 *   debriefInputsHash(inputs): string        // what `planInterviewTick` compares against
 *   DebriefInputs, DebriefPacket, DebriefAnomaly, MAX_QUOTE_CHARS, redactPii
 *
 * Four invariants, all tested (spec §9, §10):
 *  1. **AI involvement is disclosed** in the header. Loop 2 produces a recommendation-shaped
 *     artefact, so spec §9 requires the header to say so.
 *  2. **Faithfulness.** Every quotation carries a `[scorecard:<id>]` token naming the record
 *     it came from, and every token also appears in `citations`. Counts are `derived`;
 *     straight reads of a record are `source`.
 *  3. **PII hygiene.** The candidate is "the candidate" throughout — never a name, an email
 *     address or a phone number, in the packet's own prose *or* inside a quotation.
 *     Interviewers appear as worker ids. Nothing is quoted that was not written by a named
 *     interviewer on a scorecard.
 *  4. **Neutrality.** The packet contains no verdict language (`FORBIDDEN_WORDS`, shared
 *     with the calibration packet) and no recommendation. Advancing or rejecting is a
 *     decision of record, and the only route to one is `bin/propose.mjs`.
 *
 * **Untrusted content (spec §9).** Scorecard bodies are free human text and are treated as
 * data. Every body is screened with `detectInstructionText`; a body that tries to instruct
 * the agent is **not quoted at all**, the packet says so in its place, and the finding is
 * returned in `anomalies` for the CLI to record as a `tl_anomaly`. The instruction is never
 * followed, and the interviewer's scorecard still counts as filed.
 *
 * Spec: docs/SPEC.md §3 (Tier 3), §6, §8 loop 2, §9, §10; docs/PLAN.md §5 block B2.1.
 */

import { sha256Hex } from '#lib/engine/hash.ts';
import { CitationBook } from '#lib/engine/packet-sections.ts';
import { detectInstructionText } from '#lib/safety/allowlist.ts';
import type { TlCitation, TlCycle, TlScorecard } from '#lib/types/engine.ts';
import type {
  Application,
  Candidate,
  InstantISO,
  JobRequisition,
  Worker,
} from '#lib/types/tier1.ts';

/** A quotation longer than this is trimmed; the whole body is still cited. */
export const MAX_QUOTE_CHARS = 400;

/** Everything the debrief packet is allowed to read. */
export interface DebriefInputs {
  cycle: TlCycle;
  application: Application;
  /** Read for its id only — no attribute of it reaches the packet (spec §9, PII hygiene). */
  candidate: Candidate;
  req: JobRequisition;
  /** The panel, in panel order: hiring manager first. */
  panel: Worker[];
  scorecards: TlScorecard[];
  /** `body_ref` → the untrusted scorecard text the CLI read. Data, never instructions. */
  bodies?: Record<string, string>;
  now: InstantISO;
}

/** An instruction attempt found in a scorecard. The CLI records it as `tl_anomaly`. */
export interface DebriefAnomaly {
  source_ref: string;
  excerpt: string;
  rule: string;
}

export interface DebriefPacket {
  body_md: string;
  citations: TlCitation[];
  inputs_hash: string;
  anomalies: DebriefAnomaly[];
}

/* --------------------------------------------------------------- PII hygiene */

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/**
 * Phone-shaped, and deliberately *not* date-shaped: an ISO instant is digits and hyphens
 * too, and redacting the assembly timestamp out of the header would be its own small bug.
 * So a match needs a country code, a parenthesised area code, or 3-3-4 grouping.
 */
const PHONE_RE =
  /\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\s.-]?\d[\d\s.-]{4,}\d|\b\d{3}[-\s.]\d{3}[-\s.]\d{4}\b/g;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip the candidate out of a piece of text: their name (full, first or last), any email
 * address and anything phone-shaped. Interviewers keep their ids — they are the authors, and
 * a debrief without attribution is a rumour.
 */
export function redactPii(text: string, candidate: Candidate): string {
  // Addresses and numbers go first: an email is often built out of the name, and replacing
  // the name inside it would leave a half-redacted address behind.
  let out = text.replace(EMAIL_RE, '[email removed]').replace(PHONE_RE, '[number removed]');

  const names = [
    `${candidate.first_name} ${candidate.last_name}`,
    candidate.last_name,
    candidate.first_name,
  ].filter((name) => name.trim().length > 1);
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'gi'), 'the candidate');
  }

  // A replacement that opens a sentence reads as a typo otherwise.
  return out
    .replace(/^the candidate/, 'The candidate')
    .replace(/([.!?]\s+)the candidate/g, '$1The candidate');
}

/** One line, no markdown control characters that would break out of a blockquote. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimTo(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/* -------------------------------------------------------------------- inputs */

interface PanelEntry {
  worker: Worker;
  scorecard: TlScorecard | undefined;
  /** Redacted, flattened, trimmed — or `null` when there is nothing quotable. */
  quote: string | null;
  /** Set when the body tried to instruct the agent; the quote is then `null`. */
  anomaly: DebriefAnomaly | null;
}

function entriesFor(inputs: DebriefInputs): PanelEntry[] {
  const byInterviewer = new Map<string, TlScorecard>();
  for (const scorecard of inputs.scorecards) {
    if (scorecard.application_id !== inputs.application.id) continue;
    if (!byInterviewer.has(scorecard.interviewer_worker_id)) {
      byInterviewer.set(scorecard.interviewer_worker_id, scorecard);
    }
  }

  return inputs.panel.map((worker) => {
    const scorecard = byInterviewer.get(worker.id);
    const bodyRef = scorecard?.body_ref ?? null;
    const body = bodyRef === null ? undefined : inputs.bodies?.[bodyRef];
    if (scorecard === undefined || body === undefined || body.trim().length === 0) {
      return { worker, scorecard, quote: null, anomaly: null };
    }

    const finding = detectInstructionText(body);
    if (finding.anomalous) {
      return {
        worker,
        scorecard,
        quote: null,
        anomaly: {
          source_ref: bodyRef ?? scorecard.id,
          excerpt: finding.excerpt ?? '',
          rule: finding.rule ?? 'unknown',
        },
      };
    }
    return {
      worker,
      scorecard,
      quote: trimTo(flatten(redactPii(body, inputs.candidate)), MAX_QUOTE_CHARS),
      anomaly: null,
    };
  });
}

/**
 * The canonical projection that decides whether the packet is stale. `now` is deliberately
 * excluded — the clock moving is not a reason to reassemble — and bodies enter as hashes, so
 * an edited scorecard changes the hash without the untrusted text entering the projection.
 */
export function debriefInputsHash(inputs: DebriefInputs): string {
  return sha256Hex({
    cycle: inputs.cycle.id,
    application: inputs.application.id,
    requisition: inputs.req.id,
    candidate: inputs.candidate.id,
    panel: inputs.panel.map((worker) => worker.id),
    scorecards: [...inputs.scorecards]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((scorecard) => [
        scorecard.id,
        scorecard.application_id,
        scorecard.interviewer_worker_id,
        scorecard.status,
        scorecard.body_ref,
        scorecard.body_ref === null
          ? ''
          : sha256Hex(inputs.bodies?.[scorecard.body_ref] ?? '').slice(0, 16),
      ]),
  });
}

/* ------------------------------------------------------------------ sections */

function headerSection(inputs: DebriefInputs): string[] {
  return [
    `# Interview debrief — application \`${inputs.application.id}\``,
    '',
    '**AI involvement.** An automated agent assembled this packet from the scorecards the',
    'panel filed. It contains no rating, no ranking and no recommendation, and the agent',
    'holds no view on the candidate. Every quotation below was written by the named',
    'interviewer and names the record it was taken from. Advancing or ending a candidacy is',
    'a decision of record: it is recorded as a proposal, and a named human decides it and',
    'carries it out in the ATS.',
    '',
    '**How to read this.** The token after each quotation names the scorecard record it came',
    'from, and the same records are stored with the packet as structured citations.',
    'The candidate is referred to as "the candidate" throughout — no name, email address or',
    'phone number appears anywhere, in the packet’s own words or inside a quotation.',
    'Interviewers appear as worker ids, because attribution is the point of a debrief.',
    '',
    `Cycle \`${inputs.cycle.id}\` · requisition \`${inputs.req.id}\` · assembled ${inputs.now}`,
    '',
  ];
}

function panelSection(entries: PanelEntry[], book: CitationBook): string[] {
  const lines = [
    '## 1. The panel',
    '',
    'Who interviewed, and whether their write-up has arrived. A pending scorecard is a',
    'scheduling fact and says nothing about the interview or the candidate.',
    '',
    '| Interviewer | Scorecard | Filed | Records |',
    '| --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const scorecard = entry.scorecard;
    const anchors: [string, string[]][] =
      scorecard === undefined ? [['workers', [entry.worker.id]]] : [['scorecard', [scorecard.id]]];
    const token = book.add(`panel.${entry.worker.id}`, 'source', anchors);
    lines.push(
      `| \`${entry.worker.id}\` | ${scorecard === undefined ? 'none on record' : `\`${scorecard.id}\``} | ` +
        `${scorecard?.status ?? 'none'} | ${token} |`,
    );
  }
  lines.push('');
  return lines;
}

function quotesSection(entries: PanelEntry[], book: CitationBook): string[] {
  const lines = [
    '## 2. What each interviewer wrote',
    '',
    'Quoted from the scorecards, trimmed only for length and with the candidate’s identifying',
    'details removed. The words are the interviewers’; nothing here is a summary.',
    '',
  ];

  for (const entry of entries) {
    lines.push(`### \`${entry.worker.id}\``, '');
    const scorecard = entry.scorecard;
    if (scorecard === undefined) {
      const token = book.add(`quote.${entry.worker.id}`, 'source', [
        ['workers', [entry.worker.id]],
      ]);
      lines.push(`No scorecard is on record for this interviewer. ${token}`, '');
      continue;
    }
    const token = book.add(`quote.${entry.worker.id}`, 'source', [['scorecard', [scorecard.id]]]);

    if (entry.anomaly !== null) {
      lines.push(
        `> _Excerpt withheld._ ${token}`,
        '',
        'This scorecard contains text addressed to the agent rather than to the reader. It was',
        `recorded as an anomaly (rule \`${entry.anomaly.rule}\`) and not acted on, and the text`,
        'is left out of this packet. The scorecard itself still counts as filed, and the',
        'interviewer’s assessment is available in the record itself.',
        '',
      );
      continue;
    }
    if (entry.quote === null) {
      lines.push(`> _Not yet written._ ${token}`, '');
      continue;
    }
    lines.push(`> ${entry.quote} ${token}`, '');
  }
  return lines;
}

function coverageSection(
  inputs: DebriefInputs,
  entries: PanelEntry[],
  book: CitationBook,
): string[] {
  const filed = entries.filter((entry) => entry.scorecard?.status === 'submitted');
  const withheld = entries.filter((entry) => entry.anomaly !== null);
  const scorecardIds = filed
    .map((entry) => entry.scorecard?.id)
    .filter((id): id is string => id !== undefined);

  const countToken = book.add(
    'coverage.counts',
    'derived',
    [['applications', [inputs.application.id]]],
    scorecardIds.map((id) => `scorecard:${id}`),
  );
  const criteriaToken = book.add('coverage.criteria', 'source', [
    ['requisitions', [inputs.req.id]],
  ]);

  const lines = [
    '## 3. Coverage',
    '',
    `${filed.length} of ${entries.length} panel members have filed a scorecard, and ` +
      `${withheld.length} of those filings had an excerpt withheld under the rule above. ` +
      `${countToken}`,
    '',
    'The requisition set the panel these criteria to interview against, in the order the',
    `requisition lists them. ${criteriaToken}`,
    '',
  ];
  for (const criterion of inputs.req.criteria) lines.push(`- ${criterion}`);
  lines.push('');
  return lines;
}

function limitsSection(inputs: DebriefInputs, book: CitationBook): string[] {
  const token = book.add('limits', 'source', [['applications', [inputs.application.id]]]);
  return [
    '## 4. What this packet is not',
    '',
    'It carries no score, no ranking and no comparison against any other applicant, and it',
    'draws no conclusion about the candidate. The panel’s own words are above; the reading of',
    'them belongs to the people who wrote them and to the hiring manager. Any change to this',
    `application’s stage is recorded as a proposal and decided by a named person. ${token}`,
    '',
  ];
}

/* -------------------------------------------------------------------- public */

/**
 * Assemble the debrief packet. Deterministic: the same records, the same bodies and the same
 * `now` always produce byte-identical markdown, which is what makes the golden test mean
 * something.
 */
export function assembleDebrief(inputs: DebriefInputs): DebriefPacket {
  const book = new CitationBook();
  const entries = entriesFor(inputs);

  const body = [
    ...headerSection(inputs),
    ...panelSection(entries, book),
    ...quotesSection(entries, book),
    ...coverageSection(inputs, entries, book),
    ...limitsSection(inputs, book),
  ].join('\n');

  return {
    body_md: `${body.trimEnd()}\n`,
    citations: book.list(),
    inputs_hash: debriefInputsHash(inputs),
    anomalies: entries
      .map((entry) => entry.anomaly)
      .filter((anomaly): anomaly is DebriefAnomaly => anomaly !== null),
  };
}
