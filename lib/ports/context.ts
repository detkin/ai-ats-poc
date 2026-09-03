/**
 * lib/ports/context.ts — who the agent is acting as.
 *
 * Owns: `ActorContext`, the identity every port call is made under, and the
 * `AdapterMode` union that selects a port implementation.
 *
 * Public interface: `ActorContext`, `AdapterMode`, `ADAPTER_MODES`.
 *
 * Rippling backing: the acting identity comes from per-user OAuth on the Rippling MCP
 * (`codemode.lookup_me`) or, on REST, from the customer API token's creator. Permissions are
 * Rippling's own (scopes ∩ creator permissions; MCP access assignments per Supergroup) —
 * see docs/research/rippling-06-api-mcp-surface.md.
 *
 * Spec: docs/SPEC.md §9 (runs as a real user, never elevates); docs/PLAN.md §2.3.
 */

/**
 * `fixture` — the committed synthetic tenant, no network (the default).
 * `rippling`  — direct Rippling calls; stubs until a REST token exists (D25).
 * `bridge`    — Tier-1 data the *agent* fetched from the Rippling MCP and imported with
 *               `bin/bridge.mjs import`; the fixture port classes read it from
 *               `TL_DATA_DIR/tier1` (docs/PLAN.md §8, D25–D27).
 */
export const ADAPTER_MODES = ['fixture', 'rippling', 'bridge'] as const;
export type AdapterMode = (typeof ADAPTER_MODES)[number];

/**
 * The acting user. Reads are limited to what this user can read; writes are attributed to
 * them in the ledger's `actor` and `permission_context`. The engine never elevates.
 */
export interface ActorContext {
  worker_id: string;
  email: string;
  /** Rippling permission/scope strings this actor holds; copied into every ledger entry. */
  permissions: readonly string[];
  adapter: AdapterMode;
}
