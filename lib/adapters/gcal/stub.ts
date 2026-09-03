/**
 * lib/adapters/gcal/stub.ts — real Google Calendar is not connected, and says so loudly.
 *
 * Owns: `GcalStubAdapter` and `GcalNotConnectedError`. Every method names the Google call it
 * would have made and points at `docs/QUESTIONS.md` Q3 (Slack and Google Calendar). Nothing
 * here talks to a network and nothing here invents a plausible answer: a made-up free slot
 * would put a hold on a stranger's calendar, which is precisely the failure the POC claims
 * it cannot have (spec §9, "blast radius").
 *
 * **The seam.** This stub is the POC's stand-in twice over. Google is itself only a stand-in
 * for Rippling's own calendar layer, which federates Google/O365 through the Workspace
 * connector and books interviews with Smart Scheduling; on an internal build the free/busy
 * read and the hold write both move there (spec §4).
 *
 * Public interface: `GcalStubAdapter` (implements `FreeBusyPort`), `GcalNotConnectedError`,
 * `GCAL_BACKING`, `GCAL_QUESTION_REF`.
 *
 * Spec: docs/SPEC.md §2, §4; docs/PLAN.md §5 block B2.1; docs/QUESTIONS.md Q3.
 */

import type { HoldInput, HoldResult, Slot } from '#lib/ports/availability.ts';
import type { BusyBlock, BusyRange, FreeBusyPort } from '#lib/ports/freebusy.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

/** Where the user is asked to connect the calendar. */
export const GCAL_QUESTION_REF = 'docs/QUESTIONS.md Q3 (Slack and Google Calendar)';

/** Port method → the Google Calendar call that would serve it. */
export const GCAL_BACKING = {
  busy: 'google_calendar.freebusy.query',
  placeHold: 'google_calendar.events.insert',
} as const;

/** Thrown by every method of the real-Google adapter until a calendar is connected. */
export class GcalNotConnectedError extends TalentLoopsError {
  readonly call: string;

  constructor(call: string) {
    super(
      'GCAL_NOT_CONNECTED',
      `Google Calendar is not connected, so ${call} cannot run. ` +
        `Connect it (see ${GCAL_QUESTION_REF}) or run with TL_ADAPTER=fixture, which uses ` +
        'fixtures/tenant/calendar_busy.json and never touches a network.',
    );
    this.name = 'GcalNotConnectedError';
    this.call = call;
  }
}

export class GcalStubAdapter implements FreeBusyPort {
  async busy(_workerIds: WorkerId[], _range: BusyRange): Promise<BusyBlock[]> {
    throw new GcalNotConnectedError(GCAL_BACKING.busy);
  }

  async placeHold(_slot: Slot, _input: HoldInput): Promise<HoldResult> {
    throw new GcalNotConnectedError(GCAL_BACKING.placeHold);
  }
}
