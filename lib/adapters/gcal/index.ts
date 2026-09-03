/**
 * lib/adapters/gcal/index.ts — the Google Calendar seam, in one import.
 *
 * Owns: nothing. It re-exports the fixture free/busy adapter and the not-connected stub so
 * the composition root (`lib/adapters/index.ts`) has a single place to reach for. Both
 * implement `FreeBusyPort` (`lib/ports/freebusy.ts`), the *secondary* availability signal
 * that `lib/availability/compose.ts` puts behind Rippling absence.
 *
 * **The seam, once more:** Google is a stand-in for Rippling's own calendar layer. On an
 * internal build free/busy comes from the Workspace connector and the hold is a Smart
 * Scheduling call, and this directory goes away (spec §4).
 *
 * Spec: docs/SPEC.md §4; docs/PLAN.md §5 block B2.1; docs/QUESTIONS.md Q3.
 */

export {
  CALENDAR_BUSY_FILE,
  GcalFixtureAdapter,
  HOLDS_FILENAME,
  readCalendarBusy,
} from '#lib/adapters/gcal/fixture.ts';
export type { GcalFixtureOptions, HoldLine } from '#lib/adapters/gcal/fixture.ts';
export {
  GCAL_BACKING,
  GCAL_QUESTION_REF,
  GcalNotConnectedError,
  GcalStubAdapter,
} from '#lib/adapters/gcal/stub.ts';
