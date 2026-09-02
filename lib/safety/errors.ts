/**
 * lib/safety/errors.ts — the error types the safety layer throws.
 *
 * Owns: `TalentLoopsError` (base, carries a stable `code`) and `WriteNotAllowedError`
 * (thrown by the write allowlist). Kept separate from `allowlist.ts` so adapters can
 * `instanceof`-check without importing the allowlist tables.
 *
 * Public interface: `TalentLoopsError`, `WriteNotAllowedError`, `PROPOSAL_PATH_HINT`.
 *
 * Spec: docs/SPEC.md §9 (write allowlist enforced in the adapter, not the prompt).
 *
 * Note: `tsconfig` sets `erasableSyntaxOnly`, so no parameter properties — fields are
 * assigned in the constructor body.
 */

/** Every rejection message points here: the one path a non-allowlisted action may take. */
export const PROPOSAL_PATH_HINT =
  'Record it as a tl_proposed_action via bin/propose.mjs and have a named human decide it via bin/decide.mjs.';

export class TalentLoopsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TalentLoopsError';
    this.code = code;
  }
}

/**
 * A write was attempted that the allowlist does not permit. The adapter rejects the call
 * and the ledger records it with `result: 'rejected'` (spec §9).
 */
export class WriteNotAllowedError extends TalentLoopsError {
  readonly port: string;
  readonly fn: string;
  readonly target: string;

  constructor(port: string, fn: string, target: string) {
    super(
      'WRITE_NOT_ALLOWED',
      `Write not allowed: ${port}.${fn} on "${target}" is outside the write allowlist. ${PROPOSAL_PATH_HINT}`,
    );
    this.name = 'WriteNotAllowedError';
    this.port = port;
    this.fn = fn;
    this.target = target;
  }
}
