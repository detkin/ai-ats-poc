/**
 * lib/cli/propose.ts — the only door a decision of record comes through (block B1.3).
 *
 * Owns: `createProposal`, the single code path that writes a `tl_proposed_action`. The tick
 * calls it for escalations; `bin/propose.mjs` calls it for everything a human asks for. There
 * is deliberately no second way: spec §9 makes "decisions of record are proposed, decided by a
 * named human, logged with who and when" a property of the code, and one writer is what makes
 * that checkable — `verify-loops.mjs` can reconcile proposals against the ledger because every
 * proposal has exactly one shape and one origin.
 *
 * A proposal is always created `proposed`. Nothing here decides anything; `bin/decide.mjs`
 * does that, and only a named ACTIVE worker can.
 *
 * Public interface: `PROPOSE_SPEC`, `runPropose`, `createProposal`, `ProposalInput`,
 * `parsePayload`.
 *
 * Spec: docs/SPEC.md §7 step 3, §9; docs/PLAN.md §2.9, §4 block B1.3.
 */

import type { Runtime } from '#lib/adapters/index.ts';
import { UsageError } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { openRuntime } from '#lib/cli/runtime.ts';
import { loadCycle } from '#lib/cli/snapshot.ts';
import { PROPOSED_ACTION_KINDS } from '#lib/types/engine.ts';
import type { JsonValue, TlProposedAction, TlProposedActionKind } from '#lib/types/engine.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

export const PROPOSE_SPEC: CliSpec = {
  name: 'propose.mjs',
  summary: 'record a tl_proposed_action for a named human to decide',
  usage: [
    'bin/propose.mjs --cycle <id> --kind <k> --payload <json> --rationale <text> --evidence <id,id> [--by <w_id>]',
  ],
  flags: [
    { name: 'cycle', type: 'string', value: '<id>', description: 'cycle the proposal belongs to' },
    {
      name: 'kind',
      type: 'string',
      value: '<k>',
      description: `one of ${PROPOSED_ACTION_KINDS.join(' | ')}`,
    },
    {
      name: 'payload',
      type: 'string',
      value: '<json>',
      description: 'JSON object with the action-specific fields',
    },
    { name: 'rationale', type: 'string', value: '<text>', description: 'why, in one sentence' },
    {
      name: 'evidence',
      type: 'string',
      value: '<id,id>',
      description: 'record ids backing the rationale — ids, never prose',
      commaList: true,
    },
    {
      name: 'by',
      type: 'string',
      value: '<w_id>',
      description: 'worker recorded as the proposer (default: the acting identity)',
    },
  ],
  notes: [
    'A proposal is always created with status `proposed`. Approving or declining it is\n' +
      '`bin/decide.mjs`, and only an ACTIVE worker may do it.',
  ],
};

export interface ProposalInput {
  cycle_id: string;
  kind: TlProposedActionKind;
  payload: Record<string, JsonValue>;
  rationale: string;
  evidence_refs: string[];
  /** Worker recorded as `created_by`; defaults to the acting identity. */
  created_by?: WorkerId;
}

/** Parse `--payload`; anything that is not a JSON object is a usage error. */
export function parsePayload(raw: string | undefined): Record<string, JsonValue> {
  if (raw === undefined || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `propose.mjs: --payload is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('propose.mjs: --payload must be a JSON object, e.g. \'{"task_ids":[]}\'');
  }
  return parsed as Record<string, JsonValue>;
}

/** Validate a `--kind` value against `PROPOSED_ACTION_KINDS`. */
export function parseKind(raw: string): TlProposedActionKind {
  const found = PROPOSED_ACTION_KINDS.find((kind) => kind === raw);
  if (found === undefined) {
    throw new UsageError(
      `propose.mjs: --kind "${raw}" is not a proposal kind ` +
        `(expected ${PROPOSED_ACTION_KINDS.join(' | ')})`,
    );
  }
  return found;
}

/**
 * Write the proposal. The state adapter assigns the id, the timestamps and — unless
 * `created_by` names someone — the acting identity, and the ledgered wrapper records the call.
 */
export async function createProposal(rt: Runtime, input: ProposalInput): Promise<TlProposedAction> {
  return rt.ports.state.create('proposed_action', {
    cycle_id: input.cycle_id,
    kind: input.kind,
    payload: input.payload,
    rationale: input.rationale,
    evidence_refs: [...input.evidence_refs],
    status: 'proposed',
    ...(input.created_by === undefined ? {} : { created_by: input.created_by }),
  });
}

export async function runPropose(args: Args): Promise<CliOutput> {
  const cycleId = args.require('cycle');
  const kind = parseKind(args.require('kind'));
  const rationale = args.require('rationale');
  const evidence = args.all('evidence');
  if (evidence.length === 0) {
    throw new UsageError('propose.mjs: --evidence needs at least one record id');
  }
  const payload = parsePayload(args.get('payload'));
  const by = args.get('by');

  const { rt } = openRuntime({ cycleId });
  const cycle = await loadCycle(rt, cycleId);

  const proposal = await createProposal(rt, {
    cycle_id: cycle.id,
    kind,
    payload,
    rationale,
    evidence_refs: evidence,
    ...(by === undefined ? {} : { created_by: by }),
  });

  return ok(proposal, [
    `Proposed ${proposal.kind}: ${proposal.id} (${proposal.status})`,
    `  cycle     ${cycle.id} — ${cycle.name}`,
    `  by        ${proposal.created_by}`,
    `  evidence  ${proposal.evidence_refs.length} record id(s)`,
    `  decide    node bin/decide.mjs --proposal ${proposal.id} --by <w_id> --decision approve|decline`,
  ]);
}
