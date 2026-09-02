/**
 * lib/types/index.ts — one import for the whole data model.
 *
 * Owns: nothing; re-exports `#lib/types/tier1.ts` (real entities) and
 * `#lib/types/engine.ts` (tl_* state and shadow objects).
 *
 * Spec: docs/SPEC.md §3, §6; docs/PLAN.md §2.1–2.2.
 */

export * from '#lib/types/tier1.ts';
export * from '#lib/types/engine.ts';
