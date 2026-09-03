/**
 * tests/adapters/gcal.test.ts — the labelled Google Calendar seam (spec §4).
 *
 * Covers: the fixture adapter reads `calendar_busy.json`, filters by worker and range and
 * answers deterministically; a placed hold is appended to `holds.jsonl` with the acting
 * worker, the attendees and a `hold_ref`; a fixtures dir with no calendar file is an empty
 * calendar rather than an error; and the real-Google stub throws for every method, naming
 * the call it would have made and pointing at `docs/QUESTIONS.md` Q3.
 *
 * Spec: docs/SPEC.md §2, §4, §9; docs/PLAN.md §5 block B2.1; docs/QUESTIONS.md Q3.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CALENDAR_BUSY_FILE,
  GcalFixtureAdapter,
  GcalNotConnectedError,
  GcalStubAdapter,
  HOLDS_FILENAME,
  readCalendarBusy,
} from '#lib/adapters/gcal/index.ts';
import type { HoldLine } from '#lib/adapters/gcal/index.ts';
import { repoRoot } from '#lib/config.ts';
import { STAFF_ENG_SLOT } from '#lib/fixtures/gen/calendar.ts';

const FIXTURES_DIR = join(repoRoot(), 'fixtures', 'tenant');
const NOW = new Date('2026-09-02T16:00:00Z');
const WEEK = { from: '2026-09-07T00:00:00Z', to: '2026-09-12T00:00:00Z' };

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tl-gcal-'));
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function adapter(): GcalFixtureAdapter {
  return new GcalFixtureAdapter({
    fixturesDir: FIXTURES_DIR,
    dataDir,
    actorWorkerId: 'w_0114',
    now: () => NOW,
  });
}

function readHolds(): HoldLine[] {
  return readFileSync(join(dataDir, HOLDS_FILENAME), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HoldLine);
}

describe('the fixture free/busy adapter', () => {
  it('loads the committed busy blocks and stamps them as gcal', async () => {
    const blocks = await adapter().busy(['w_0025'], WEEK);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.source === 'gcal')).toBe(true);
    expect(blocks[0]).toEqual({
      worker_id: 'w_0025',
      start_at: '2026-09-08T12:00:00Z',
      end_at: '2026-09-08T23:00:00Z',
      source: 'gcal',
    });
  });

  it('returns nothing for a worker who was not asked about', async () => {
    const blocks = await adapter().busy(['w_0007'], WEEK);
    expect(blocks.every((block) => block.worker_id === 'w_0007')).toBe(true);
  });

  it('filters to the range and orders by start then worker', async () => {
    const blocks = await adapter().busy(['w_0002', 'w_0007', 'w_0024', 'w_0025', 'w_0028'], {
      from: '2026-09-09T00:00:00Z',
      to: '2026-09-10T00:00:00Z',
    });
    expect(blocks.map((block) => `${block.start_at}|${block.worker_id}`)).toEqual([
      '2026-09-09T16:00:00Z|w_0002',
      '2026-09-09T18:00:00Z|w_0007',
      '2026-09-09T19:00:00Z|w_0024',
      '2026-09-09T20:00:00Z|w_0025',
      '2026-09-09T21:00:00Z|w_0028',
    ]);
  });

  it('treats a fixtures dir with no calendar file as an empty calendar', async () => {
    const empty = new GcalFixtureAdapter({
      fixturesDir: dataDir,
      dataDir,
      actorWorkerId: 'w_0114',
      now: () => NOW,
    });
    expect(await empty.busy(['w_0007'], WEEK)).toEqual([]);
    expect(readCalendarBusy(dataDir)).toEqual([]);
  });

  it('reads pre-loaded rows without touching the disk', async () => {
    const preloaded = new GcalFixtureAdapter({
      dataDir,
      actorWorkerId: 'w_0114',
      now: () => NOW,
      rows: [{ worker_id: 'w_0999', start_at: WEEK.from, end_at: WEEK.to }],
    });
    expect(await preloaded.busy(['w_0999'], WEEK)).toHaveLength(1);
  });

  it('names the file the fixture calendar lives in', () => {
    expect(CALENDAR_BUSY_FILE).toBe('calendar_busy.json');
    expect(readCalendarBusy(FIXTURES_DIR).length).toBeGreaterThan(0);
  });
});

describe('placing a hold', () => {
  it('appends one line to holds.jsonl and returns its hold_ref', async () => {
    const gcal = adapter();
    const result = await gcal.placeHold(
      { ...STAFF_ENG_SLOT, worker_ids: ['w_0007', 'w_0002'] },
      { title: 'Onsite — req_staff_eng', attendees: ['w_0007', 'w_0002'] },
    );
    expect(result.hold_ref).toMatch(/^hold_[0-9a-f]{8}$/);

    const holds = readHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]).toEqual({
      ts: '2026-09-02T16:00:00Z',
      hold_ref: result.hold_ref,
      actor: 'w_0114',
      title: 'Onsite — req_staff_eng',
      start_at: STAFF_ENG_SLOT.start_at,
      end_at: STAFF_ENG_SLOT.end_at,
      attendees: ['w_0007', 'w_0002'],
    });
  });

  it('falls back to the slot attendees when the input names none', async () => {
    const gcal = adapter();
    await gcal.placeHold(
      { ...STAFF_ENG_SLOT, worker_ids: ['w_0030'] },
      { title: 'Onsite', attendees: [] },
    );
    expect(readHolds()[0]?.attendees).toEqual(['w_0030']);
  });

  it('only ever appends', async () => {
    const gcal = adapter();
    await gcal.placeHold(
      { ...STAFF_ENG_SLOT, worker_ids: ['w_0007'] },
      { title: 'a', attendees: [] },
    );
    await gcal.placeHold(
      { ...STAFF_ENG_SLOT, worker_ids: ['w_0002'] },
      { title: 'b', attendees: [] },
    );
    expect(readHolds()).toHaveLength(2);
  });
});

describe('the real-Google stub', () => {
  it('throws for every method, pointing at the open question', async () => {
    const stub = new GcalStubAdapter();
    await expect(stub.busy(['w_0007'], WEEK)).rejects.toBeInstanceOf(GcalNotConnectedError);
    await expect(
      stub.placeHold({ ...STAFF_ENG_SLOT, worker_ids: [] }, { title: 'x', attendees: [] }),
    ).rejects.toBeInstanceOf(GcalNotConnectedError);
    await expect(stub.busy(['w_0007'], WEEK)).rejects.toThrow(/QUESTIONS\.md Q3/);
    await expect(stub.busy(['w_0007'], WEEK)).rejects.toThrow(/freebusy\.query/);
  });
});
