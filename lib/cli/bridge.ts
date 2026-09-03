/**
 * lib/cli/bridge.ts — `bin/bridge.mjs`: fetch-plan, import, status (block B2.6).
 *
 * Owns `BRIDGE_SPEC` and `runBridge`, the three commands that make a real Rippling tenant
 * readable by the unchanged engine:
 *
 *   fetch-plan   print the ordered `codemode.*` calls the **agent** must run and the JSON
 *                shape to save. Nothing is fetched here: the MCP's OAuth token lives in the
 *                Claude client, so a Node process cannot reach it (docs/DECISIONS.md D25).
 *   import       validate + map + write `TL_DATA_DIR/tier1/**` and `provenance.json`.
 *   status       what was imported, when, and whether it is stale for this tick interval.
 *
 * `fetch-plan --json` is the machine form: `{ telemetry_required, steps: [...], walk, file }`,
 * so an agent can drive the calls off the JSON instead of parsing the prose.
 *
 * Public interface: `BRIDGE_SPEC`, `runBridge`, `FETCH_PLAN`, `fetchPlanLines`,
 * `bridgeStatus`, `StatusResult`.
 *
 * Spec: docs/PLAN.md §8; docs/DECISIONS.md D25–D27; modes/live-run.md.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SNAPSHOT_FILENAME,
  bridgeTier1Dir,
  importSnapshot,
  provenancePath,
  readProvenance,
} from '#lib/adapters/bridge/index.ts';
import type { Provenance } from '#lib/adapters/bridge/index.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { fail, ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError } from '#lib/cli/runtime.ts';
import { loadConfig, now as clockNow } from '#lib/config.ts';
import { POLICY_FILENAME, loadPolicy } from '#lib/policy/index.ts';
import { join } from 'node:path';

export const BRIDGE_SPEC: CliSpec = {
  name: 'bridge.mjs',
  summary: 'plan, import and inspect a Rippling MCP snapshot for TL_ADAPTER=bridge',
  usage: [
    'bin/bridge.mjs fetch-plan [--json]',
    'bin/bridge.mjs import --from <path> [--json]',
    'bin/bridge.mjs status [--json]',
  ],
  subcommands: [
    { name: 'fetch-plan', description: 'print the codemode.* calls the agent must run' },
    { name: 'import', description: 'validate and map a saved snapshot into TL_DATA_DIR/tier1' },
    { name: 'status', description: 'provenance, counts and age of the imported tenant' },
  ],
  flags: [
    {
      name: 'from',
      type: 'string',
      value: '<path>',
      description: 'snapshot JSON to import (the file the fetch-plan told you to save)',
    },
  ],
  notes: [
    'The Rippling MCP is agent-executed (docs/DECISIONS.md D25): this CLI never makes a\n' +
      'network call. It prints what to run, and ingests what you saved.',
    'Every codemode.* call must carry telemetry: { intent } in its args, or the gateway\n' +
      'rejects it (docs/DECISIONS.md D26).',
  ],
};

/* ----------------------------------------------------------------- fetch plan */

interface PlanStep {
  step: number;
  fn: string;
  args: string;
  saves_to: string;
  why: string;
}

/** The ordered read plan. Six functions, plus one optional (`search_teams`). */
export const FETCH_PLAN: readonly PlanStep[] = [
  {
    step: 1,
    fn: 'codemode.lookup_me',
    args: '{ telemetry: { intent: "talent-loops bridge: identify the acting user" } }',
    saves_to: 'actor',
    why: 'the acting identity, the company id, and the root of the org walk',
  },
  {
    step: 2,
    fn: 'codemode.search_departments',
    args: '{ query: "", telemetry: { intent: "talent-loops bridge: department catalogue" } }',
    saves_to: 'departments',
    why: 'departments nest; parent_id becomes Department.parent_department_id',
  },
  {
    step: 3,
    fn: 'codemode.search_work_locations',
    args: '{ query: "", telemetry: { intent: "talent-loops bridge: work locations" } }',
    saves_to: 'locations',
    why: 'addresses only — no timezone, no hours; the mapper derives both (D27)',
  },
  {
    step: 4,
    fn: 'codemode.search_leave_types',
    args: '{ query: "", telemetry: { intent: "talent-loops bridge: leave types" } }',
    saves_to: 'leave_types',
    why: 'names the leave an absence is on',
  },
  {
    step: 5,
    fn: 'codemode.search_teams',
    args: '{ query: "", telemetry: { intent: "talent-loops bridge: teams" } }',
    saves_to: 'teams (optional)',
    why: 'zero results on the observed tenant; omit the key if it returns none',
  },
  {
    step: 6,
    fn: 'codemode.lookup_direct_reports',
    args:
      '{ worker_id: "<id>", telemetry: { intent: "talent-loops bridge: org walk" } } ' +
      '— once per manager, starting at the actor',
    saves_to: 'direct_reports["<manager id>"]',
    why: 'search_people matches names only, so the org is enumerated through the tree',
  },
  {
    step: 7,
    fn: 'codemode.lookup_person',
    args: '{ worker_id: "<id>", telemetry: { intent: "talent-loops bridge: profile" } } — once per id',
    saves_to: 'people[]',
    why: 'direct-report rows are thin: title, timezone, manager and is_manager need the profile',
  },
  {
    step: 8,
    fn: 'codemode.lookup_absence',
    args: '{ worker_id: "<id>", telemetry: { intent: "talent-loops bridge: absence" } } — once per id',
    saves_to: 'absences["<worker id>"]',
    why: 'present-tense only: is_on_leave now, no dated history (D27)',
  },
];

const WALK_STEPS: readonly string[] = [
  'let queue = [ lookup_me().id ]; let seen = new Set()',
  'while queue is not empty: pop id; if seen has id, continue; seen.add(id)',
  '  people.push( lookup_person({ worker_id: id }) )',
  '  absences[id] = lookup_absence({ worker_id: id })',
  '  const reports = lookup_direct_reports({ worker_id: id })',
  '  if reports.total_direct_reports > 0: direct_reports[id] = reports',
  '  push every reports.direct_reports[].id onto the queue',
  'stop when the queue is empty — that is the whole tree under the acting user',
];

const FILE_SHAPE: readonly string[] = [
  '{',
  '  "fetched_at": "<ISO instant>",',
  '  "actor":       <lookup_me result>,',
  '  "departments": <search_departments result>,',
  '  "locations":   <search_work_locations result>,',
  '  "leave_types": <search_leave_types result>,',
  '  "teams":       <search_teams result>,          // optional',
  '  "people":      [ <lookup_person result>, ... ],',
  '  "direct_reports": { "<manager id>": <lookup_direct_reports result>, ... },',
  '  "absences":       { "<worker id>":  <lookup_absence result>, ... },',
  '  "balances":       { "<worker id>":  <lookup_time_off_balance result>, ... },  // optional',
  '  "calls": [ { "fn": "lookup_me", "args_summary": "{}", "ok": true }, ... ]',
  '}',
];

/** The human form of the plan. */
export function fetchPlanLines(snapshotPath: string): string[] {
  const lines: string[] = [
    'Rippling MCP fetch plan (agent-executed — this CLI makes no network call).',
    '',
    'Run each call below through the Rippling `code` tool. Every call MUST carry',
    'telemetry: { intent } inside its args or the gateway rejects it.',
    '',
  ];
  for (const step of FETCH_PLAN) {
    lines.push(`${step.step}. ${step.fn}`);
    lines.push(`     args:  ${step.args}`);
    lines.push(`     save:  ${step.saves_to}`);
    lines.push(`     why:   ${step.why}`);
  }
  lines.push(
    '',
    'Org walk (steps 6-8 are one loop, not three passes):',
    ...WALK_STEPS.map((step) => `  ${step}`),
    '',
    `Save the result as ${snapshotPath}, shaped:`,
    ...FILE_SHAPE.map((line) => `  ${line}`),
    '',
    'Then: node bin/bridge.mjs import --from <that file>',
    '',
    'Not available through the MCP, and therefore not in the bridge: candidates,',
    'applications, requisitions, headcount and compensation are redacted, and',
    'lookup_absence answers only for today.',
  );
  return lines;
}

/* --------------------------------------------------------------------- status */

export interface StatusResult {
  ok: boolean;
  data_dir: string;
  tier1_dir: string;
  imported: boolean;
  provenance: Provenance | null;
  /** Hours between `fetched_at` and the run's clock; null when nothing is imported. */
  age_hours: number | null;
  stale: boolean;
  tick_interval_hours: number;
}

/** Provenance plus how old it is against `cadence.tick_interval_hours`. */
export function bridgeStatus(dataDir: string, now: Date, tickIntervalHours: number): StatusResult {
  const provenance = readProvenance(dataDir);
  const fetchedMs = provenance === null ? Number.NaN : Date.parse(provenance.fetched_at);
  const ageHours = Number.isNaN(fetchedMs)
    ? null
    : Math.round(((now.getTime() - fetchedMs) / 3_600_000) * 100) / 100;
  return {
    ok: provenance !== null,
    data_dir: dataDir,
    tier1_dir: bridgeTier1Dir(dataDir),
    imported: provenance !== null,
    provenance,
    age_hours: ageHours,
    stale: ageHours !== null && ageHours > tickIntervalHours,
    tick_interval_hours: tickIntervalHours,
  };
}

/* ------------------------------------------------------------------ the CLI */

function runFetchPlan(snapshotPath: string): CliOutput {
  return ok(
    {
      ok: true,
      command: 'fetch-plan',
      telemetry_required: true,
      steps: FETCH_PLAN.map((step) => ({ ...step })),
      walk: [...WALK_STEPS],
      file: snapshotPath,
      file_shape: [...FILE_SHAPE],
    },
    fetchPlanLines(snapshotPath),
  );
}

function runImport(args: Args): CliOutput {
  const from = args.get('from');
  if (from === undefined || from.length === 0) {
    throw new CliError(
      'BRIDGE_NO_SNAPSHOT',
      'bridge.mjs import needs --from <path> — the JSON file the fetch-plan told you to save.',
    );
  }
  const path = resolve(from);
  if (!existsSync(path)) {
    throw new CliError('BRIDGE_NO_SNAPSHOT', `no snapshot file at ${path}.`);
  }
  const config = loadConfig();
  const policy = loadPolicy(join(config.tenantDir, POLICY_FILENAME));
  const result = importSnapshot(path, config, policy);
  const counts = result.provenance.counts;

  return ok(
    {
      ok: true,
      command: 'import',
      from: path,
      tier1_dir: result.tier1Dir,
      provenance_path: provenancePath(config.dataDir),
      counts,
      seeded_state: result.seededState,
      warnings: result.warnings,
    },
    [
      `Imported ${path}`,
      `  tier1 → ${result.tier1Dir}`,
      `  ${Object.entries(counts)
        .map(([key, value]) => `${key} ${value}`)
        .join('  ')}`,
      `  fetched ${result.provenance.fetched_at} · company ${result.provenance.company_id ?? '—'}`,
      result.seededState
        ? '  seeded empty runtime state and ledger'
        : '  left the existing runtime state and ledger alone',
      ...(result.warnings.length === 0
        ? ['  no warnings']
        : [`  ${result.warnings.length} warning(s):`, ...result.warnings.map((w) => `    - ${w}`)]),
      '',
      'Next: node bin/doctor.mjs   then the steps in modes/live-run.md',
    ],
  );
}

function runStatus(): CliOutput {
  const config = loadConfig();
  const policy = loadPolicy(join(config.tenantDir, POLICY_FILENAME));
  const status = bridgeStatus(config.dataDir, clockNow(config), policy.cadence.tick_interval_hours);

  if (!status.imported) {
    return fail({ ...status, command: 'status' }, [
      `No imported tenant in ${status.data_dir}.`,
      `  expected ${provenancePath(status.data_dir)}`,
      '  run: node bin/bridge.mjs fetch-plan   then: node bin/bridge.mjs import --from <path>',
    ]);
  }

  const provenance = status.provenance;
  return ok({ ...status, command: 'status' }, [
    `Imported tenant in ${status.tier1_dir}`,
    `  source ${provenance?.source} · mapping v${provenance?.mapping_version}`,
    `  fetched ${provenance?.fetched_at} (${status.age_hours ?? '?'} h ago)`,
    `  actor ${provenance?.actor_worker_id} · company ${provenance?.company_id ?? '—'}`,
    `  ${Object.entries(provenance?.counts ?? {})
      .map(([key, value]) => `${key} ${value}`)
      .join('  ')}`,
    `  ${provenance?.calls.length ?? 0} codemode calls recorded`,
    status.stale
      ? `  STALE: older than cadence.tick_interval_hours (${status.tick_interval_hours} h) — re-fetch before ticking`
      : '  fresh for this tick interval',
    ...(provenance?.warnings.length
      ? [
          `  ${provenance.warnings.length} mapping warning(s):`,
          ...provenance.warnings.map((w) => `    - ${w}`),
        ]
      : []),
  ]);
}

export async function runBridge(args: Args): Promise<CliOutput> {
  const command = args.requireSubcommand();
  if (command === 'fetch-plan') {
    const config = loadConfig();
    return runFetchPlan(join(config.dataDir, 'bridge', SNAPSHOT_FILENAME));
  }
  if (command === 'import') return runImport(args);
  return runStatus();
}
