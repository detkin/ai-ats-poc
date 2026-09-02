/**
 * lib/cli/decide.ts — a named human approves or declines a proposal (block B1.3).
 *
 * Owns: `decideProposal`, the only writer of `tl_proposed_action.status`, `decided_by`,
 * `decided_at` and `decision_note`. Two rules are enforced here rather than hoped for:
 *
 *  1. **The decider is a real, ACTIVE worker.** `--by` is looked up through the Graph port;
 *     an unknown or TERMINATED id is a domain failure, not a warning. A decision of record
 *     signed by nobody is worse than no decision (spec §9).
 *  2. **A decision is a record, not an execution.** In M1 approving an `escalate` proposal
 *     marks it approved and stops. It does not waive the bundled tasks, change a rating, or
 *     move an application: the human who approved it acts in the real system, and the next
 *     tick observes the result. Wiring approvals to side effects would put the engine back in
 *     the business of making decisions, which is exactly what spec §9 forbids.
 *
 * The states contract (`templates/loop-states.yml`) is what rejects a second decision: the
 * state adapter refuses `approved → declined`, so a decided proposal is decided for good.
 *
 * Public interface: `DECIDE_SPEC`, `runDecide`, `decideProposal`, `DecisionInput`.
 *
 * Spec: docs/SPEC.md §7 step 3, §9; docs/PLAN.md §2.9, §4 block B1.3.
 */

import type { Runtime } from '#lib/adapters/index.ts';
import { UsageError } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError, openRuntime } from '#lib/cli/runtime.ts';
import { toInstant } from '#lib/adapters/index.ts';
import type { TlProposalState, TlProposedAction } from '#lib/types/engine.ts';
import type { WorkerId } from '#lib/types/tier1.ts';

export const DECIDE_SPEC: CliSpec = {
  name: 'decide.mjs',
  summary: 'record a named human approving or declining a proposal',
  usage: ['bin/decide.mjs --proposal <id> --by <w_id> --decision approve|decline [--note <t>]'],
  flags: [
    { name: 'proposal', type: 'string', value: '<id>', description: 'tl_proposed_action id' },
    {
      name: 'by',
      type: 'string',
      value: '<w_id>',
      description: 'worker making the decision; must be an ACTIVE worker',
    },
    {
      name: 'decision',
      type: 'string',
      value: 'approve|decline',
      description: 'the decision to record',
    },
    { name: 'note', type: 'string', value: '<t>', description: 'optional free-text note' },
  ],
  notes: [
    'A decision is a record. M1 performs no side effect on approval: the human acts in the\n' +
      'real system and the next tick observes it.',
  ],
};

export interface DecisionInput {
  proposalId: string;
  by: WorkerId;
  decision: 'approve' | 'decline';
  note?: string;
}

const STATUS_BY_DECISION: Record<'approve' | 'decline', TlProposalState> = {
  approve: 'approved',
  decline: 'declined',
};

/** Validate `--decision`. */
export function parseDecision(raw: string): 'approve' | 'decline' {
  if (raw === 'approve' || raw === 'decline') return raw;
  throw new UsageError(`decide.mjs: --decision "${raw}" must be approve or decline`);
}

/**
 * Record the decision.
 * @throws CliError when the proposal is unknown, or `by` is not an ACTIVE worker.
 */
export async function decideProposal(rt: Runtime, input: DecisionInput): Promise<TlProposedAction> {
  const proposal = await rt.ports.state.get('proposed_action', input.proposalId);
  if (proposal === null) {
    throw new CliError(
      'PROPOSAL_NOT_FOUND',
      `no proposal with id "${input.proposalId}". List them with: node bin/cycle.mjs show --cycle <id>`,
    );
  }

  const decider = await rt.ports.graph.lookupPerson(input.by);
  if (decider === null) {
    throw new CliError(
      'DECIDER_NOT_FOUND',
      `no worker with id "${input.by}" — a decision of record needs a real person.`,
    );
  }
  if (decider.status !== 'ACTIVE') {
    throw new CliError(
      'DECIDER_NOT_ACTIVE',
      `worker "${input.by}" is ${decider.status}; only an ACTIVE worker may decide a proposal.`,
    );
  }

  return rt.ports.state.update('proposed_action', proposal.id, {
    status: STATUS_BY_DECISION[input.decision],
    decided_by: decider.id,
    decided_at: toInstant(rt.now()),
    ...(input.note === undefined ? {} : { decision_note: input.note }),
  });
}

export async function runDecide(args: Args): Promise<CliOutput> {
  const proposalId = args.require('proposal');
  const by = args.require('by');
  const decision = parseDecision(args.require('decision'));
  const note = args.get('note');

  const { rt } = openRuntime();
  const decided = await decideProposal(rt, {
    proposalId,
    by,
    decision,
    ...(note === undefined ? {} : { note }),
  });

  return ok(decided, [
    `Proposal ${decided.id} is ${decided.status}.`,
    `  kind        ${decided.kind}`,
    `  decided by  ${decided.decided_by ?? '(none)'} at ${decided.decided_at ?? '(none)'}`,
    `  evidence    ${decided.evidence_refs.length} record id(s)`,
    ...(decided.decision_note === undefined ? [] : [`  note        ${decided.decision_note}`]),
    '  (a decision is a record; M1 performs no side effect on approval)',
  ]);
}
