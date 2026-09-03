/**
 * lib/fixtures/gen/calendar.ts — the Google Calendar free/busy fixture (`calendar_busy.json`).
 *
 * Owns: `generateCalendarBusy()` and the named rows the loop-2 demo turns on. **This is the
 * labelled seam of spec §4**: meeting-level free/busy is the one availability signal
 * Rippling's API does not expose, so the fixtures carry a small Google-shaped table for it.
 * It says only "this person is in a meeting". It never says anybody is *away* — absence,
 * leave and holidays are Rippling's answer and live in `absences.json` / `holidays.json`.
 *
 * The table is hand-written and consumes no PRNG: the interview-loop demo needs *specific*
 * time to be busy, and a random calendar would make the walkthrough unrepeatable.
 *
 * What the rows are built to prove, on the `req_staff_eng` onsite panel:
 *   1. Monday 2026-09-07 yields **no** slot at all — Labor Day is a holiday at SF, NYC and
 *      Remote (US), and absence is checked before any calendar is read.
 *   2. Tuesday 2026-09-08 yields no slot because `w_0025` is busy all day.
 *   3. Wednesday 2026-09-09 has **exactly one** 60-minute window where all four panellists
 *      are free: 17:00–18:00Z (10:00 Pacific / 13:00 Eastern).
 *   4. The substitute `w_0028` is free in that window, so the decline/re-book beat lands on
 *      the same slot.
 *
 * Public interface: `generateCalendarBusy`, `STAFF_ENG_PANEL`, `STAFF_ENG_DECLINER`,
 * `STAFF_ENG_SUBSTITUTE`, `STAFF_ENG_SLOT`, `CALENDAR_WEEK`.
 *
 * Spec: docs/SPEC.md §4, §8 loop 2; docs/PLAN.md §5 block B2.1.
 */

import type { CalendarBusyRow } from '#lib/fixtures/gen/bundle.ts';
import type { InstantISO, WorkerId } from '#lib/types/tier1.ts';

/**
 * The panel `panelFor(req_staff_eng, …)` derives: the hiring manager plus the three
 * lowest-id ACTIVE Platform team members at level rank ≥ 5 (the req is L6, rank 6, and the
 * rule admits one level down). Declared here so the fixture and `fixtures/README.md` cannot
 * drift from the engine; `tests/engine/interview-loop.test.ts` asserts they agree.
 */
export const STAFF_ENG_PANEL: readonly WorkerId[] = ['w_0007', 'w_0002', 'w_0024', 'w_0025'];

/** The panellist the loop-2 demo has decline (Bo Lindgren, L5, Platform, SF). */
export const STAFF_ENG_DECLINER: WorkerId = 'w_0024';

/** Their same-team, same-rank stand-in (Hassan Barros, L5, Platform, NYC) — free and present. */
export const STAFF_ENG_SUBSTITUTE: WorkerId = 'w_0028';

/** The only 60-minute window on 2026-09-09 the whole panel shares. */
export const STAFF_ENG_SLOT: { start_at: InstantISO; end_at: InstantISO } = {
  start_at: '2026-09-09T17:00:00Z',
  end_at: '2026-09-09T18:00:00Z',
};

/** The week the fixture calendar covers, inclusive. */
export const CALENDAR_WEEK = { from: '2026-09-07', to: '2026-09-11' } as const;

/**
 * Every busy block, in file order. Times are UTC; the panel spans San Francisco
 * (09:00–18:00 PDT = 16:00–01:00Z) and New York (09:00–18:00 EDT = 13:00–22:00Z), so the
 * only window where the whole panel is inside working hours is 16:00–22:00Z.
 */
const ROWS: readonly CalendarBusyRow[] = [
  // Tuesday: w_0025 is out of reach all day, so no full panel can meet.
  {
    worker_id: 'w_0025',
    start_at: '2026-09-08T12:00:00Z',
    end_at: '2026-09-08T23:00:00Z',
    title: 'Design partner offsite',
  },
  {
    worker_id: 'w_0007',
    start_at: '2026-09-08T16:00:00Z',
    end_at: '2026-09-08T17:00:00Z',
    title: 'Platform staff meeting',
  },
  {
    worker_id: 'w_0024',
    start_at: '2026-09-08T18:00:00Z',
    end_at: '2026-09-08T19:00:00Z',
    title: 'Incident review',
  },
  // Wednesday: everything except 17:00–18:00Z is taken by somebody on the panel.
  {
    worker_id: 'w_0002',
    start_at: '2026-09-09T16:00:00Z',
    end_at: '2026-09-09T17:00:00Z',
    title: 'Exec staff meeting',
  },
  {
    worker_id: 'w_0007',
    start_at: '2026-09-09T18:00:00Z',
    end_at: '2026-09-09T19:00:00Z',
    title: 'Skip-level 1:1s',
  },
  {
    worker_id: 'w_0024',
    start_at: '2026-09-09T19:00:00Z',
    end_at: '2026-09-09T20:00:00Z',
    title: 'Platform design review',
  },
  {
    worker_id: 'w_0025',
    start_at: '2026-09-09T20:00:00Z',
    end_at: '2026-09-09T22:00:00Z',
    title: 'Customer escalation bridge',
  },
  // The substitute has a calendar of his own, but not over the chosen slot.
  {
    worker_id: 'w_0028',
    start_at: '2026-09-09T21:00:00Z',
    end_at: '2026-09-09T22:00:00Z',
    title: 'Support rotation handoff',
  },
  // Thursday and Friday: enough load that "earliest first" has something to order.
  {
    worker_id: 'w_0002',
    start_at: '2026-09-10T16:00:00Z',
    end_at: '2026-09-10T17:00:00Z',
    title: 'Exec staff meeting',
  },
  {
    worker_id: 'w_0007',
    start_at: '2026-09-10T16:00:00Z',
    end_at: '2026-09-10T17:30:00Z',
    title: 'Roadmap review',
  },
  {
    worker_id: 'w_0024',
    start_at: '2026-09-10T17:00:00Z',
    end_at: '2026-09-10T18:00:00Z',
    title: 'Pairing session',
  },
  {
    worker_id: 'w_0025',
    start_at: '2026-09-11T16:00:00Z',
    end_at: '2026-09-11T20:00:00Z',
    title: 'Interview loop, other requisition',
  },
  {
    worker_id: 'w_0028',
    start_at: '2026-09-11T16:00:00Z',
    end_at: '2026-09-11T17:00:00Z',
    title: 'Sprint planning',
  },
];

/** The fixture calendar. Deterministic and PRNG-free: the same rows on every run. */
export function generateCalendarBusy(): CalendarBusyRow[] {
  return ROWS.map((row) => ({ ...row }));
}
