/**
 * The calibration packet (block B1.1, `lib/engine/packet.ts`).
 *
 * Covers spec §10's "judged, every packet" list as deterministic assertions: faithfulness
 * (every figure carries a citation token that also appears in `citations`), neutrality (no
 * verdict language), PII hygiene (no names, no email addresses, no pay amounts), a stable
 * `inputs_hash`, and a byte-exact golden body at `evals/golden/calibration-h2-2026.md`.
 *
 * The golden is regenerated **deliberately**: run the suite with `TL_UPDATE_GOLDEN=1` and
 * commit the diff. Any accidental change to the packet fails this file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assembleCalibration,
  calibrationInputsHash,
  findForbiddenWords,
  CITATION_TOKEN_RE,
} from '#lib/engine/packet.ts';
import { TEST_NOW, openedFixtureCycle } from '#tests/engine/helpers.ts';
import type { CalibrationInputs } from '#lib/engine/packet.ts';
import type { TlReviewSubmission } from '#lib/types/engine.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = path.join(REPO_ROOT, 'evals', 'golden', 'calibration-h2-2026.md');

const opened = openedFixtureCycle();

/**
 * A partly-complete cycle: every Engineering worker has filed their self review, nobody
 * else has filed anything. Deterministic, and it gives section 4 something to show.
 */
function submissions(): TlReviewSubmission[] {
  const engineering = new Set(
    opened.bundle.workers.filter((w) => w.department_id === 'dept_eng').map((w) => w.id),
  );
  return opened.submissions.map((submission) =>
    submission.kind === 'self' && engineering.has(submission.author_worker_id)
      ? { ...submission, status: 'submitted' as const, submitted_at: '2026-08-28T12:00:00Z' }
      : submission,
  );
}

const inputs: CalibrationInputs = {
  cycle: opened.cycle,
  workers: opened.participants,
  levels: opened.bundle.levels,
  bands: opened.bundle.comp_bands,
  locations: opened.bundle.locations,
  prior_ratings: opened.bundle.prior_ratings,
  submissions: submissions(),
  now: TEST_NOW,
};

const packet = assembleCalibration(inputs);

/** Lines that are allowed to carry a figure with no citation: headings, table rules, preamble. */
function claimLines(body: string): string[] {
  const lines = body.split('\n');
  const firstSection = lines.findIndex((line) => line.startsWith('## '));
  return lines
    .slice(firstSection)
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
    .filter((line) => line.trim() !== '');
}

describe('assembleCalibration: faithfulness', () => {
  it('puts a citation token on every line that states a figure', () => {
    const uncited = claimLines(packet.body_md)
      .filter((line) => /\d/.test(line.replace(CITATION_TOKEN_RE, '')))
      .filter((line) => (line.match(CITATION_TOKEN_RE) ?? []).length === 0);
    expect(uncited).toEqual([]);
  });

  it('backs every inline token with a stored citation over the same records', () => {
    const stored = new Set(packet.citations.flatMap((c) => c.record_ids));
    const inline: string[] = [];
    for (const line of packet.body_md.split('\n')) {
      for (const match of line.matchAll(CITATION_TOKEN_RE)) {
        const [, kind, ids] = match;
        for (const id of (ids ?? '').split(',')) inline.push(`${kind}:${id}`);
      }
    }
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.filter((ref) => !stored.has(ref))).toEqual([]);
  });

  it('gives every claim a unique id and labels aggregates as derived', () => {
    const claimIds = packet.citations.map((c) => c.claim_id);
    expect(new Set(claimIds).size).toBe(claimIds.length);
    expect(packet.citations.every((c) => c.kind === 'source' || c.kind === 'derived')).toBe(true);
    expect(packet.citations.every((c) => c.record_ids.length > 0)).toBe(true);
  });

  it('cites real record ids', () => {
    const known = new Set<string>([
      ...opened.bundle.workers.map((w) => `workers:${w.id}`),
      ...opened.bundle.workers.map((w) => `prior_ratings:${w.id}`),
      ...opened.bundle.departments.map((d) => `departments:${d.id}`),
      ...opened.bundle.comp_bands.map((b) => `comp_bands:${b.id}`),
      ...opened.submissions.map((s) => `review_submissions:${s.id}`),
      `cycles:${opened.cycle.id}`,
    ]);
    const unknown = packet.citations.flatMap((c) => c.record_ids).filter((ref) => !known.has(ref));
    expect(unknown).toEqual([]);
  });
});

describe('assembleCalibration: neutrality and PII', () => {
  it('contains no verdict language', () => {
    expect(findForbiddenWords(packet.body_md)).toEqual([]);
  });

  it('discloses that an agent assembled it', () => {
    expect(packet.body_md).toMatch(/\*\*AI involvement\.\*\*/);
    expect(packet.body_md.split('\n').slice(0, 12).join('\n')).toMatch(/no rating/i);
  });

  it('carries no email address', () => {
    expect(packet.body_md).not.toContain('@');
  });

  it('carries no worker names, only ids', () => {
    const surnames = new Set(opened.bundle.workers.map((w) => w.last_name));
    const found = [...surnames].filter((name) => packet.body_md.includes(name));
    expect(found).toEqual([]);
  });

  it('carries no pay amounts — only compa-ratios', () => {
    const amounts = new Set(opened.bundle.workers.map((w) => String(w.compensation?.base_annual)));
    const found = [...amounts].filter((amount) => packet.body_md.includes(amount));
    expect(found).toEqual([]);
    expect(packet.body_md).toMatch(/compa-ratio/i);
  });
});

describe('assembleCalibration: content', () => {
  it('names the prior cycle as the only rating source', () => {
    expect(packet.body_md).toContain('source: prior_ratings, FY2025 Year-End');
    expect(packet.body_md).toContain('the engine never writes a rating');
  });

  it('observes the seeded distribution outlier without judging it', () => {
    // fixtures/README.md: w_0008's eight reports average 4.75 in FY2025.
    expect(packet.body_md).toMatch(/Manager `w_0008` has a prior-cycle mean of 4\.75/);
  });

  it('counts the seeded out-of-band workers', () => {
    for (const id of ['w_0026', 'w_0111', 'w_0024', 'w_0116']) {
      expect(packet.body_md).toContain(id);
    }
  });

  it('is deterministic', () => {
    expect(assembleCalibration(inputs).body_md).toBe(packet.body_md);
  });
});

describe('calibrationInputsHash', () => {
  it('ignores the clock', () => {
    expect(calibrationInputsHash({ ...inputs, now: '2027-01-01T00:00:00Z' })).toBe(
      packet.inputs_hash,
    );
  });

  it('moves when a submission arrives', () => {
    const first = inputs.submissions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const changed = [{ ...first, status: 'submitted' as const }, ...inputs.submissions.slice(1)];
    expect(calibrationInputsHash({ ...inputs, submissions: changed })).not.toBe(packet.inputs_hash);
  });

  it('moves when a band moves', () => {
    const first = inputs.bands[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const changed = [{ ...first, mid: first.mid + 1 }, ...inputs.bands.slice(1)];
    expect(calibrationInputsHash({ ...inputs, bands: changed })).not.toBe(packet.inputs_hash);
  });

  it('is a sha256 hex digest', () => {
    expect(packet.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('golden packet', () => {
  it('matches evals/golden/calibration-h2-2026.md exactly', () => {
    if (process.env.TL_UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, packet.body_md, 'utf8');
    expect(packet.body_md).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
