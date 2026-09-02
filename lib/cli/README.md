# `lib/cli` — the nine scripts, and what each one is allowed to do

`bin/*.mjs` are three lines each: parse arguments, call one function here, render the result
(docs/DECISIONS.md D11). Everything real — the flags, the exit codes, the order of port calls
— lives in this directory, which is why it can be unit-tested without spawning a process.

Shared plumbing: `args.ts` (the parser and `--help` renderer, driven by a declarative
`CliSpec`), `output.ts` (`{ code, data, lines }`; `--json` prints `data` and nothing else),
`runtime.ts` (`openRuntime` + `runCli`, the one place exit codes are decided), `snapshot.ts`
(the only place a `TickSnapshot` is read from live ports), `execute.ts` (a plan → ledgered
port calls), `templates.ts` (nudge text from `templates/nudges/*.md`).

**Exit codes, everywhere:**

| code | meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | success                                                                              |
| 1    | domain failure — drift, a held lock, an unknown id, an illegal transition, a refusal |
| 2    | usage or configuration — a bad flag, a bad `TL_*`, an unseeded `TL_DATA_DIR`         |

`RuntimeStateMissingError`, `ConfigError` and `PolicyError` are exit 2 and print their own fix
line (`node bin/seed.mjs --reset`, the offending variable, the policy path).

## The scripts

**`seed.mjs`** `[--verify | --reset] [--dir <path>] [--seed <n>] [--json]` — regenerates the
fixture tenant, or verifies it by regenerating into a temp dir and diffing manifests (so a
hand-edited file is caught even if its hash was rewritten), or copies `fixtures/tenant/state/`
into `TL_DATA_DIR` and starts the ledger empty. `--reset` also clears the scratch that would
otherwise outlive the state it describes: `ticks/`, `locks/` and `outbox.jsonl`. An unknown
flag exits **1** here rather than 2 — this CLI predates the exit-code contract and its tests
pin the old behaviour.

**`cycle.mjs`** `create --type review|interview --name <n> --owner <w_id> [--department <id>]…
[--application <app_id>] --deadline <date>` | `open --cycle <id>` | `close --cycle <id>` |
`show --cycle <id>` — `create` records a `configured` cycle with `opened_at: null` and
`policy_ref: tenant/policy.yml`. `open` stamps `opened_at`, moves to `running` and creates one
`tl_task` and one pending `tl_review_submission` per unit of work (`tasksFor` /
`submissionsFor`), each as its own ledgered `state.create`. Opening an already-open cycle is
refused, as is opening an `interview` cycle (that lands in M2, block B2.2). `close` refuses
unless every task is terminal and every proposal decided, and lists what is outstanding;
otherwise it walks `running|escalated → closing → closed`.

**`tick.mjs`** `--cycle <id> [--dry-run] [--scan <ref>]… [--json]` — one tick under the
per-cycle lock: build the snapshot through the ports, `planTick` (pure), execute the plan,
record the tick. `--scan` adds an untrusted document (a résumé, a review body) to the texts
this tick screens; an instruction aimed at the agent becomes a `tl_anomaly` and nothing else.
`--dry-run` plans and reports without writing and without recording the tick. Output:
`{ tick_id, changed, detected: {…}, actions: [{ kind, task_id?, … }], escalations, closed }`.
A second tick with nothing new reports `changed: false` and appends only _read_ lines to the
ledger.

**`propose.mjs`** `--cycle <id> --kind <k> --payload <json> --rationale <text> --evidence
<id,id> [--by <w_id>]` — the only writer of a `tl_proposed_action`. The tick's escalations go
through the same `createProposal` function. Always creates `proposed`.

**`decide.mjs`** `--proposal <id> --by <w_id> --decision approve|decline [--note <t>]` — records
`status`, `decided_by`, `decided_at`, `decision_note`. `--by` must be an **ACTIVE** worker. In
M1 a decision is a _record only_: approving an `escalate` proposal does not waive the tasks it
bundled, change a rating or move an application. The human acts in the real system and the next
tick observes the result — wiring approvals to side effects would put the engine back in the
business of deciding (spec §9).

**`nudge.mjs`** `--task <id> [--template <id>] [--force-policy-check]` — runs the engine's own
`policyCheckFor` on one task. On a pass: send, record the `tl_nudge`, move the task to `nudged`
with the new `attempt_n`. On a failure: record a `tl_nudge` with `delivered: false`, `sent_at:
null` and the failing `policy_check`, leave the task untouched, exit 1. `--force-policy-check`
_runs and prints_ the check without sending or recording anything — **there is no flag that
bypasses the gate**, by design (spec §4).

**`packet.mjs`** `assemble --cycle <id> --kind calibration [--staging <dir>]` |
`show --packet <id>` — the engine assembles the body (`assembleCalibration`, no LLM, every
figure cited), then every `*.json` in the staging directory is merged in `section_id` order
after it. A partial is `{ section_id, body_md, citations[] }`; a malformed one fails the
assembly rather than silently dropping a section. Default staging directory:
`staging/<cycle_id>/` under the repo root.

**`audit.mjs`** `--cycle <id> [--format md|json] [--limit <n>]` — renders the ledger for a
cycle: `ts / actor / port.function / result / result_ref / tick_id`, plus writes by port,
rejected count, distinct ticks and actors. Reads through `rt.raw.ledger`, so auditing appends
nothing.

**`verify-loops.mjs`** `[--cycle <id>]` — seven reconciliation rules over state, the ledger and
Tier 1; exit 1 with the offending ids named. See the header of `verify.ts` for the list. Records
whose ids are not adapter-assigned (`tl_<kind>_<8 hex>`) are exempt from the "must have a ledger
line" rule: the seeded `tl_cycle_h2_2026` was written by the fixture generator, not by an agent.

## Three things worth knowing before changing anything here

**Last-tick state is not `tl_*` state.** The previous tick's task statuses live at
`<TL_DATA_DIR>/ticks/<cycle_id>.json`, deliberately outside `state/`. It exists only for the
"diff vs last tick" step of detect, it is not a custom object, it is not ledgered, it is not
audited, and deleting it costs nothing but a slightly noisier next tick. `TlCycle` has no field
for it, and adding one would make a scratch value part of the tenant's data model.

**The stored `inputs_hash` is the engine's, not the merged body's.** Staging partials are
contributed prose, not engine inputs. If they counted toward the hash, the tick's "the packet is
stale" test would depend on who happened to drop a file, and a re-run over unchanged records
would never settle.

**`prior_ratings` has no port.** `lib/ports/*` exposes Graph, Ats, Bands, Availability, Channel,
State and Ledger, and none of them carries a rating, so `calibrationInputsFor` reads them off the
loaded fixture bundle (`rt.bundle.prior_ratings`). On fixtures that is correct and complete; a
Rippling adapter will need a real read before the calibration packet works on a tenant. This is
the one place in `lib/cli` that touches the bundle instead of a port.

## Adding a CLI

1. Write `lib/cli/<name>.ts` exporting a `CliSpec` and a `run<Name>(args) => Promise<CliOutput>`.
   Declare **every** flag on the spec: `--help` is generated from it, and
   `tests/modes/consistency.test.ts` checks mode files against that output.
2. Add `bin/<name>.mjs` — three lines, no logic.
3. Reads and writes go through `rt.ports` (ledgered). `rt.raw` is for reconciliation and audit
   reads only. Never `new Date()`: use `rt.now()` / the `now` from `openRuntime`.
4. A decision of record is not a new CLI. It is `propose.mjs` and `decide.mjs`.
