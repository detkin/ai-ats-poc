/**
 * lib/states/index.ts — public entry point for the states contract (spec §7, plan §2.5).
 *
 * Re-exports everything in `#lib/states/loop-states.ts`. Import states helpers from
 * here so the contract file can be split later without touching call sites.
 */

export {
  MACHINE_NAMES,
  LoopStatesError,
  assertTransition,
  canonicalState,
  defaultLoopStatesPath,
  isTerminal,
  listStates,
  loadLoopStates,
} from '#lib/states/loop-states.ts';

export type {
  LoopMachine,
  LoopStateDef,
  LoopStates,
  MachineName,
} from '#lib/states/loop-states.ts';
