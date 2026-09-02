/**
 * lib/safety/allowlist.ts — the two safety invariants that are code, not prompt.
 *
 * Owns:
 *  1. `WRITE_ALLOWLIST` + `assertWriteAllowed` — the complete set of writes the agent may
 *     perform. Everything else is rejected and must become a `tl_proposed_action`.
 *  2. `detectInstructionText` — the untrusted-content rule: résumés, scorecards, review
 *     bodies and Slack replies are data. Imperative text aimed at the agent is recorded as
 *     a `tl_anomaly`, never obeyed.
 *
 * Public interface: `WRITE_ALLOWLIST`, `AllowlistedPort`, `isWriteAllowed`,
 * `assertWriteAllowed`, `INSTRUCTION_RULES`, `detectInstructionText`, `InstructionFinding`,
 * `MAX_EXCERPT_CHARS`.
 *
 * Spec: docs/SPEC.md §9 (permission and safety), §10 (evals); docs/PLAN.md §2.4.
 *
 * Not on the list, deliberately: `ledger.append`. The ledger is the *record* of a call, not
 * a call the agent elects to make; the ledgered wrapper (block B1.2) appends unconditionally,
 * including for rejected writes. `LedgerPort` has no update or delete, which is what makes
 * it append-only.
 */

import { WriteNotAllowedError } from '#lib/safety/errors.ts';

/**
 * Port → the writes permitted on it. Entries are matched against the *function name* and
 * against the *target* (the object/record being written); `*` is a trailing wildcard, so
 * `tl_*` permits every engine-state object and nothing else.
 */
export const WRITE_ALLOWLIST = {
  state: ['tl_*'],
  ats: ['createDraftHire'],
  channel: ['sendDirect', 'postChannel'],
  availability: ['placeHold'],
} as const;

export type AllowlistedPort = keyof typeof WRITE_ALLOWLIST;

/**
 * The write methods each allowlisted port actually declares. A wildcard entry above says
 * *what* may be written; this says *how*. `state` has no `delete` here because `StatePort`
 * has none — corrections are updates, and the ledger is append-only.
 */
export const PORT_WRITE_FUNCTIONS = {
  state: ['create', 'update'],
  ats: ['createDraftHire'],
  channel: ['sendDirect', 'postChannel'],
  availability: ['placeHold'],
} as const;

/** Trailing-`*` glob. `tl_*` matches `tl_task`; `tl_` and `xtl_task` do not match. */
function matchesPattern(pattern: string, value: string): boolean {
  if (!value) return false;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.length > prefix.length && value.startsWith(prefix);
  }
  return pattern === value;
}

/**
 * True when `port.fn` writing `target` is on the allowlist. Pure; no throwing.
 *
 * Both gates must pass: the function must be one the port declares as a write, and — for
 * ports whose allowlist entries are target patterns (`state: ['tl_*']`) — the target must
 * match one of them. So `state.create` on `tl_task` passes, `state.create` on `worker`
 * does not, and `state.delete` on `tl_task` does not.
 */
export function isWriteAllowed(port: string, fn: string, target: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(WRITE_ALLOWLIST, port)) return false;
  const key = port as AllowlistedPort;
  const writeFunctions: readonly string[] = PORT_WRITE_FUNCTIONS[key];
  if (!writeFunctions.includes(fn)) return false;

  const entries: readonly string[] = WRITE_ALLOWLIST[key];
  const targetPatterns = entries.filter((entry) => entry.includes('*'));
  if (targetPatterns.length === 0) return true;
  return targetPatterns.some((pattern) => matchesPattern(pattern, target));
}

/**
 * Gate every write in the adapter layer with this. Throws `WriteNotAllowedError`, whose
 * message names `bin/propose.mjs` as the only other path.
 */
export function assertWriteAllowed(port: string, fn: string, target: string): void {
  if (!isWriteAllowed(port, fn, target)) {
    throw new WriteNotAllowedError(port, fn, target);
  }
}

/* ------------------------------------------------ untrusted-content detection */

/** `tl_anomaly.excerpt` is capped here so a hostile document cannot flood state. */
export const MAX_EXCERPT_CHARS = 200;

export interface InstructionRule {
  id: string;
  /** What this rule is looking for, for the ledger and the anomaly record. */
  description: string;
  pattern: RegExp;
}

/**
 * Deliberately narrow. Each pattern needs a verb or an address to the agent, so ordinary
 * prose that merely contains "instructions", "advance" or "system" does not trip it —
 * "I followed the onboarding instructions" and "helped advance the roadmap" are benign.
 */
export const INSTRUCTION_RULES: readonly InstructionRule[] = [
  {
    id: 'ignore_prior_instructions',
    description: 'Tells the reader to ignore, disregard or forget instructions or rules',
    pattern:
      /\b(?:ignore|disregard|forget|discard)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+|those\s+|previous\s+|prior\s+|above\s+|earlier\s+|preceding\s+)*(?:instruction|instructions|prompt|prompts|rule|rules|guideline|guidelines|direction|directions)\b/i,
  },
  {
    id: 'role_reassignment',
    description: 'Attempts to reassign the agent a new role or persona',
    pattern: /\byou\s+are\s+(?:now\s+)?an?\s+\w+/i,
  },
  {
    id: 'act_as',
    description: 'Instructs the agent to act or behave as something else',
    pattern: /\b(?:act|behave|respond|pretend\s+to\s+be)\s+as\s+(?:if\s+you\s+are\s+)?an?\s+\w+/i,
  },
  {
    id: 'ai_addressed',
    description: 'Addresses the reader as an AI or language model',
    pattern: /\bas\s+an?\s+(?:ai|artificial\s+intelligence|language\s+model|llm)\b/i,
  },
  {
    id: 'system_prompt',
    description: 'References the system prompt or developer instructions',
    pattern: /\b(?:system|developer)\s+prompt\b/i,
  },
  {
    id: 'pipeline_command',
    description: 'Commands a decision of record on a candidate or application',
    pattern:
      /\b(?:advance|progress|promote|reject|hire|approve|move)\s+(?:this|the|me|my)\s+(?:candidate|application|applicant|interview|offer|req|requisition)\b/i,
  },
  {
    id: 'rating_command',
    description: 'Commands a rating, score or compensation value',
    pattern:
      /\b(?:rate|score|set)\s+(?:this|the|me|my|him|her|them)\s+\w*\s*(?:as|to|at)\s+(?:a\s+)?(?:\d|top|highest|exceeds|outstanding)/i,
  },
  {
    id: 'override_safety',
    description: 'Asks to override, bypass or disable safety controls',
    pattern:
      /\b(?:override|bypass|disable|circumvent|skip)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:safety|guardrail|guardrails|allowlist|allow-list|restriction|restrictions|policy|policies|permission|permissions|check|checks)\b/i,
  },
];

export interface InstructionFinding {
  anomalous: boolean;
  /** Whitespace-collapsed window around the match, ≤ `MAX_EXCERPT_CHARS`. */
  excerpt?: string;
  /** The `InstructionRule.id` that fired. */
  rule?: string;
}

/** Collapse runs of whitespace so excerpt offsets are stable across formatting. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function excerptAround(text: string, index: number, matchLength: number): string {
  const lead = 40;
  const start = Math.max(0, index - lead);
  const ellipsis = start > 0 ? '…' : '';
  const budget = MAX_EXCERPT_CHARS - ellipsis.length;
  const window = text.slice(start, start + Math.max(budget, matchLength));
  return (ellipsis + window.slice(0, budget)).trim();
}

/**
 * Scan untrusted free text for an instruction aimed at the agent. Never acts on the text —
 * the caller records `tl_anomaly` and continues to treat the document as data (spec §9).
 * Returns the first rule that fires; rule order is stable so anomalies are reproducible.
 */
export function detectInstructionText(text: string): InstructionFinding {
  if (typeof text !== 'string' || text.length === 0) return { anomalous: false };
  const normalized = normalize(text);
  for (const rule of INSTRUCTION_RULES) {
    const match = rule.pattern.exec(normalized);
    if (match) {
      return {
        anomalous: true,
        excerpt: excerptAround(normalized, match.index, match[0].length),
        rule: rule.id,
      };
    }
  }
  return { anomalous: false };
}
