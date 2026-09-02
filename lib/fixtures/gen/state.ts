/**
 * lib/fixtures/gen/state.ts — acting identities and the seeded Tier-2 state.
 *
 * Owns: `identities.json` (the three people the POC can run as) and the one `tl_cycle`
 * record the fixtures ship with. The cycle is `configured` and **not yet opened**:
 * `opened_at` is `null` because opening a cycle is `bin/cycle.mjs open`'s job (M1), and
 * that is what creates the tasks. Every other state array is empty and the ledger file
 * starts with zero lines — the ledger is written only by real port calls.
 *
 * Public interface: `IDENTITIES`, `REVIEW_CYCLE_ID`, `generateSeedState`.
 *
 * Spec: docs/SPEC.md §6 (Tier 2), §7 (states), §9 (runs as a real user);
 * docs/PLAN.md §2.2, §2.8, §3 block B0.4.
 */

import type { Identity } from '#lib/types/tier1.ts';
import type { TlCycle } from '#lib/types/engine.ts';
import { DEPARTMENT_SPECS, PINNED } from '#lib/fixtures/gen/catalog.ts';
import { emptyState } from '#lib/fixtures/gen/bundle.ts';
import type { TenantState } from '#lib/fixtures/gen/bundle.ts';

/** The H2 2026 mid-year review cycle the loop-1 demo runs. */
export const REVIEW_CYCLE_ID = 'tl_cycle_h2_2026';

const CYCLE_CREATED_AT = '2026-08-24T00:00:00Z';

/**
 * Permissions are Rippling's, inherited by the acting user — the engine never elevates
 * (spec §9). The strings mirror the read/write scopes each role would hold on a tenant.
 */
export const IDENTITIES: Identity[] = [
  {
    worker_id: PINNED.hrbp,
    role: 'hrbp',
    permissions: [
      'people.read',
      'absence.read',
      'comp_bands.read',
      'ats.read',
      'custom_objects.read',
      'custom_objects.write',
      'slack.send_as_user',
    ],
    is_default: true,
  },
  {
    worker_id: PINNED.recruiter,
    role: 'recruiter',
    permissions: [
      'people.read',
      'absence.read',
      'ats.read',
      'custom_objects.read',
      'custom_objects.write',
      'slack.send_as_user',
      'calendar.freebusy.read',
      'calendar.hold.write',
    ],
    is_default: false,
  },
  {
    worker_id: PINNED.hiring_manager,
    role: 'manager',
    permissions: [
      'people.read',
      'absence.read',
      'ats.read',
      'custom_objects.read',
      'custom_objects.write',
      'slack.send_as_user',
      'calendar.freebusy.read',
    ],
    is_default: false,
  },
];

export function generateSeedState(): TenantState {
  const cycle: TlCycle = {
    id: REVIEW_CYCLE_ID,
    created_at: CYCLE_CREATED_AT,
    updated_at: CYCLE_CREATED_AT,
    created_by: PINNED.hrbp,
    type: 'review',
    name: 'H2 2026 Mid-Year Review',
    status: 'configured',
    owner_worker_id: PINNED.hrbp,
    deadline: '2026-09-18T23:59:59Z',
    policy_ref: 'tenant/policy.yml',
    opened_at: null,
    scope: { department_ids: DEPARTMENT_SPECS.map((spec) => spec.id) },
  };
  const state = emptyState();
  state.cycles.push(cycle);
  return state;
}
