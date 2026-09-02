/**
 * lib/cli/audit.ts — render the append-only ledger for a cycle (block B1.3).
 *
 * Owns: `auditCycle`. Every port call the engine makes appends one `tl_agent_action` with the
 * acting user, their permission context, a hash of the arguments and a PII-free summary
 * (spec §7 step 5). This renders them: a table of `ts / actor / port.function / result /
 * result_ref / tick_id`, plus the counts a reviewer actually asks for — writes by port, how
 * many calls were **rejected** by the write allowlist, and how many distinct ticks are in the
 * window.
 *
 * It reads through `rt.raw.ledger`, not `rt.ports`: auditing the ledger must not append to
 * the ledger, or the act of looking buries the thing being looked at.
 *
 * Public interface: `AUDIT_SPEC`, `runAudit`, `auditCycle`, `AuditReport`.
 *
 * Spec: docs/SPEC.md §5 (`audit.mjs`), §7 step 5, §9, §10; docs/PLAN.md §2.9, §4 block B1.3.
 */

import type { Runtime } from '#lib/adapters/index.ts';
import { UsageError } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { ok, table } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { openRuntime } from '#lib/cli/runtime.ts';
import type { TlAgentAction } from '#lib/types/engine.ts';

export const AUDIT_SPEC: CliSpec = {
  name: 'audit.mjs',
  summary: 'render the agent-action ledger for a cycle',
  usage: ['bin/audit.mjs --cycle <id> [--format md|json]'],
  flags: [
    { name: 'cycle', type: 'string', value: '<id>', description: 'cycle whose ledger to render' },
    {
      name: 'format',
      type: 'string',
      value: 'md|json',
      description: 'output format (default md; --json is the same as --format json)',
    },
    {
      name: 'limit',
      type: 'string',
      value: '<n>',
      description: 'render at most this many of the most recent entries',
    },
  ],
  notes: ['The ledger is append-only and is read unledgered: rendering it adds no entries.'],
};

export interface AuditReport {
  cycle_id: string;
  entries: TlAgentAction[];
  summary: {
    total: number;
    reads: number;
    writes: number;
    rejected: number;
    errors: number;
    writes_by_port: Record<string, number>;
    calls_by_port: Record<string, number>;
    ticks: string[];
    actors: string[];
    first_ts: string | null;
    last_ts: string | null;
  };
}

/** Write functions, per port. Anything else in the ledger is a read. */
const WRITE_FUNCTIONS = new Set([
  'create',
  'update',
  'sendDirect',
  'postChannel',
  'placeHold',
  'createDraftHire',
  'createRequisition',
]);

function isWrite(entry: TlAgentAction): boolean {
  return WRITE_FUNCTIONS.has(entry.function);
}

/** Read and summarize the ledger for one cycle. */
export async function auditCycle(rt: Runtime, cycleId: string): Promise<AuditReport> {
  const entries = await rt.raw.ledger.list({ cycle_id: cycleId });
  const writesByPort: Record<string, number> = {};
  const callsByPort: Record<string, number> = {};
  const ticks = new Set<string>();
  const actors = new Set<string>();
  let reads = 0;
  let writes = 0;
  let rejected = 0;
  let errors = 0;

  for (const entry of entries) {
    callsByPort[entry.port] = (callsByPort[entry.port] ?? 0) + 1;
    if (isWrite(entry)) {
      writes += 1;
      writesByPort[entry.port] = (writesByPort[entry.port] ?? 0) + 1;
    } else {
      reads += 1;
    }
    if (entry.result === 'rejected') rejected += 1;
    if (entry.result === 'error') errors += 1;
    if (entry.tick_id !== undefined) ticks.add(entry.tick_id);
    actors.add(entry.actor.worker_id);
  }

  return {
    cycle_id: cycleId,
    entries,
    summary: {
      total: entries.length,
      reads,
      writes,
      rejected,
      errors,
      writes_by_port: writesByPort,
      calls_by_port: callsByPort,
      ticks: [...ticks].sort(),
      actors: [...actors].sort(),
      first_ts: entries[0]?.ts ?? null,
      last_ts: entries.at(-1)?.ts ?? null,
    },
  };
}

function renderMarkdown(report: AuditReport, shown: TlAgentAction[]): string[] {
  const rows = shown.map((entry) => [
    entry.ts,
    entry.actor.worker_id,
    `${entry.port}.${entry.function}`,
    entry.result,
    entry.result_ref ?? '',
    entry.tick_id === undefined ? '' : entry.tick_id.slice(0, 12),
  ]);

  const { summary } = report;
  return [
    `# Ledger — ${report.cycle_id}`,
    '',
    ...table(['ts', 'actor', 'port.function', 'result', 'result_ref', 'tick'], rows),
    ...(shown.length === report.entries.length
      ? []
      : ['', `_showing ${shown.length} of ${report.entries.length} entries_`]),
    '',
    '## Summary',
    '',
    `- ${summary.total} entries (${summary.reads} reads, ${summary.writes} writes)`,
    `- rejected: ${summary.rejected}; errors: ${summary.errors}`,
    `- writes by port: ${
      Object.entries(summary.writes_by_port)
        .sort()
        .map(([port, count]) => `${port} ${count}`)
        .join(', ') || 'none'
    }`,
    `- distinct ticks: ${summary.ticks.length}`,
    `- actors: ${summary.actors.join(', ') || 'none'}`,
    `- window: ${summary.first_ts ?? '—'} → ${summary.last_ts ?? '—'}`,
  ];
}

export async function runAudit(args: Args): Promise<CliOutput> {
  const cycleId = args.require('cycle');
  const format = args.get('format') ?? (args.bool('json') ? 'json' : 'md');
  if (format !== 'md' && format !== 'json') {
    throw new UsageError(`audit.mjs: --format "${format}" must be md or json`);
  }

  const limitRaw = args.get('limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new UsageError(`audit.mjs: --limit "${limitRaw}" must be a positive integer`);
  }

  const { rt } = openRuntime();
  const report = await auditCycle(rt, cycleId);
  const shown = limit === undefined ? report.entries : report.entries.slice(-limit);

  const payload = { ...report, entries: shown };
  // `--format json` prints JSON in text mode too, so the flag means the same thing either way.
  if (format === 'json') return ok(payload, [JSON.stringify(payload, null, 2)]);
  return ok(payload, renderMarkdown(report, shown));
}
