# `lib/cli` — the ten scripts, and what each one is allowed to do

`bin/*.mjs` are three lines each: parse arguments, call one function here, render the result
(docs/DECISIONS.md D11). Everything real — the flags, the exit codes, the order of port calls
— lives in this directory, which is why it can be unit-tested without spawning a process.

Shared plumbing: `args.ts` (the parser and `--help` renderer, driven by a declarative
`CliSpec`), `output.ts` (`{ code, data, lines }`; `--json` prints `data` and nothing else),
`runtime.ts` (`openRuntime` / `openRuntimeForRecord` + `runCli`, the one place exit codes are
decided), `snapshot.ts` (the only place a `TickSnapshot` is read from live ports) with
`snapshot-interview.ts` (loop 2's half of that read), `execute.ts` (a plan → ledgered port
calls) with `execute-interview.ts` (loop 2's four actions), `templates.ts` (message text from
`templates/nudges/*.md` and `templates/packets/*.md`).

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
refused. `close` refuses unless every task is terminal and every proposal decided, and lists
what is outstanding; otherwise it walks `running|escalated → closing → closed`.
`--type interview` requires `--application`, reads that application's requisition off the real
record and stores **both ids** in `scope`; `open` then re-reads the application and refuses
unless it is `ACTIVE` at stage `Onsite`, and creates **no tasks** — nothing is owed until the
first tick has found an hour and placed a hold.

**`tick.mjs`** `--cycle <id> [--dry-run] [--scan <ref>]… [--json]` — one tick under the
per-cycle lock: build the snapshot through the ports, `planTick` (pure), execute the plan,
record the tick. `--scan` adds an untrusted document (a résumé, a review body) to the texts
this tick screens; an instruction aimed at the agent becomes a `tl_anomaly` and nothing else.
`--dry-run` plans and reports without writing and without recording the tick. Output:
`{ tick_id, changed, detected: {…}, actions: [{ kind, task_id?, … }], nudges, nudged_tasks,
escalations, holds, rebooks, proposals, closed }`, where `nudges` counts **recipients** (one
`nudge` action, one DM each) and `nudged_tasks` counts the tasks those DMs covered, and
`holds` / `rebooks` / `proposals` are loop 2's beats (a panel booked, an interviewer swapped, a
candidate decision _proposed_). A second tick with nothing new reports `changed: false` and
appends only _read_ lines to the ledger. A non-dry tick also passes `observe: true` to the
snapshot, which is the licence to write down what it saw — see "How a reply becomes a fact".

**`propose.mjs`** `--cycle <id> --kind <k> --payload <json> --rationale <text> --evidence
<id,id> [--by <w_id>]` — the only writer of a `tl_proposed_action`. The tick's escalations go
through the same `createProposal` function. Always creates `proposed`.

**`decide.mjs`** `--proposal <id> --by <w_id> --decision approve|decline [--note <t>]` — records
`status`, `decided_by`, `decided_at`, `decision_note`. `--by` must be an **ACTIVE** worker. In
M1 a decision is a _record only_: approving an `escalate` proposal does not waive the tasks it
bundled, change a rating or move an application. The human acts in the real system and the next
tick observes the result — wiring approvals to side effects would put the engine back in the
business of deciding (spec §9).

**`nudge.mjs`** `--task <id> [--only-this-task] [--template <id>] [--force-policy-check]` —
runs the engine's own `policyCheckFor` on the named task. On a pass: send, record the
`tl_nudge`, move the task to `nudged` with the new `attempt_n`. On a failure: record a
`tl_nudge` with `delivered: false`, `sent_at: null` and the failing `policy_check`, leave the
task untouched, exit 1. `--force-policy-check` _runs and prints_ the check without sending or
recording anything — **there is no flag that bypasses the gate**, by design (spec §4).
`deliverNudge` here is the shared send-and-record sequence: it takes a _bundle_ of one person's
tasks, sends one DM, and writes one `tl_nudge` per task carrying that DM's `message_ref`
(docs/DECISIONS.md D17).

**`--task` names the task, not the message** (block B2.2; the M1 tester's O-1). One DM per
person also means one _cadence window_ per person, so nudging a single task used to spend the
recipient's whole `nudge_min_gap_hours` on it and silence everything else they owed. `--task`
therefore sends the reminder that person is due: the named task, plus every other task of
theirs in the cycle that is open, overdue and past the same gate. The named task is always
included, is what the gate is measured on, and is the `tl_nudge` the output reports; the whole
bundle is in `bundled_task_ids` / `nudge_ids`. `--only-this-task` restores the old behaviour
and prints a line saying the window is spent regardless.

**`doctor.mjs`** `[--json]` — the cold-start report from `lib/doctor/*`, rendered. Exit 0 when
every check is `ok` or `warn`; **1** when any check fails _or_ the `TL_*` environment is
invalid (doctor is the tool you run because the environment might be wrong, so "not ready" is
its domain answer, not a usage error); 2 on a bad argument.

**`packet.mjs`** `assemble --cycle <id> [--kind calibration|debrief] [--staging <dir>]` |
`show --packet <id>` — the engine assembles the body (no LLM, every claim cited), then every
`*.json` in the staging directory is merged in `section_id` order after it. A partial is
`{ section_id, body_md, citations[] }`; a malformed one fails the assembly rather than silently
dropping a section. Default staging directory: `staging/<cycle_id>/` under the repo root.
**The packet kind follows the cycle type** — a review cycle assembles `calibration`
(`assembleCalibration`), an interview cycle `debrief` (`assembleDebrief`); omit `--kind` and it
is chosen for you, name the other one and it is a domain failure rather than an empty packet. A
scorecard body that tried to instruct the agent is left out of the debrief and recorded as a
`tl_anomaly`, whose ids come back in `anomalies`.

**`audit.mjs`** `--cycle <id> [--format md|json] [--limit <n>]` — renders the ledger for a
cycle: `ts / actor / port.function / result / result_ref / tick_id`, plus writes by port,
rejected count, distinct ticks and actors. Reads through `rt.raw.ledger`, so auditing appends
nothing.

**`verify-loops.mjs`** `[--cycle <id>]` — ten reconciliation rules over state, the ledger and
Tier 1; exit 1 with the offending ids named. See the header of `verify.ts` for the list. Records
whose ids are not adapter-assigned (`tl_<kind>_<8 hex>`) are exempt from the "must have a ledger
line" rule: the seeded `tl_cycle_h2_2026` was written by the fixture generator, not by an agent.
Loop 2 adds three: a held `tl_interview_slot` has a line in `holds.jsonl` **and** an
`availability.placeHold ok` line in the ledger; a `done` `submit_scorecard` task has a
`submitted` `tl_scorecard`; and **no `tl_*` record anywhere carries a `stage`** — the last one
is checked across the whole runtime state, not per cycle, because a shadow pipeline would not
confine itself to the cycle being verified.

**A CLI addressed by record resolves its cycle first.** `decide --proposal`, `nudge --task` and
`packet show --packet` name a record, not a cycle, so `openRuntimeForRecord(kind, id)` looks the
record up through the _unledgered_ ports and then opens the ledgered runtime scoped to that
record's `cycle_id` (docs/DECISIONS.md D19). Without it those writes carried `cycle_id: null`
and `audit.mjs --cycle` could not show the decision of record — the one line spec §9's "logged
with who and when" is really about.

## How a reply becomes a fact (loop 2)

There is no Slack here, so an interviewer's reply is a line in `<TL_DATA_DIR>/inbox.jsonl` on
the interview hold's thread. The hold's `hold_ref` **is** the `thread_ref`: the
`interviewer_brief` DMs the tick sends when it books the panel are threaded on it, which is why
`snapshot-interview.ts` can find the replies with one `channel.readReplies(hold_ref)`.

```json
{
  "ts": "2026-09-02T18:00:00Z",
  "thread_ref": "hold_14f4bf09",
  "from_worker_id": "w_0024",
  "message_ref": "reply_w_0024_decline",
  "text": "Sorry — I can't make the Wednesday onsite."
}
```

Three rules turn that into something the engine acts on, and they are deliberately small:

1. **Every reply is screened.** It goes onto `TickSnapshot.untrusted`, `detect` runs
   `detectInstructionText` over it, and anything aimed at the agent becomes a `tl_anomaly` —
   the same path a résumé takes. Never obeyed.
2. **The author is metadata, not body text.** The `message_ref` carries it, shaped
   `<kind>_<worker_id>[_<suffix>]`; `scorecard_<worker_id>` is a filed write-up, anything else
   is an ordinary reply. A reply whose ref names no worker is screened and then ignored.
3. **A decline needs an explicit phrase** — `decline`/`declines`/`declining`, `can't make`,
   `cannot make`. A reply carrying both an injection and a real decline is _both_: the anomaly
   is recorded and the panel is re-staffed, because whether somebody can attend is a fact about
   the world rather than an instruction the text issued.

A `scorecard_*` reply moves its pending `tl_scorecard` to `submitted` with the reply's ref as
`body_ref` — the body is never inlined into state, and the debrief packet resolves the ref back
to the text when it quotes it. **That write only happens on a tick** (`observe: true`); every
other reader of a snapshot reads. It is the loop observing the world: on a real tenant the
write-up appears in Recruiting and the tick reads it there instead.

**Known gap:** `lib/ports/channel.ts` returns `UntrustedDocument` (`ref`, `text`), with no
author field, so `from_worker_id` in the JSON above is documentation for a human — the loader
parses the id out of `message_ref`. A real Slack adapter has the sender on the message; the
port should grow an author before this runs on a tenant.

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

**Two engine gaps loop 2 exposed** (reported to the orchestrator, worked around here):

1. `lib/engine/apply.ts`'s `rebook` moves the declining interviewer's _tasks_ to the stand-in
   but leaves their pending `tl_scorecard` keyed to the person who dropped out. `detect`
   matches a `submit_scorecard` task to a scorecard on `application|interviewer`, so without a
   re-key the stand-in's task could never complete and the debrief would list a panellist who
   never interviewed. `execute-interview.ts` re-keys it; the pure fold should grow the same line.
2. `planTick` nudges an `attend_interview` task that `planInterviewTick` is about to complete in
   the same tick. The task falls due at the _start_ of the slot, so the generic overdue rule
   sees it before the completion rule fires, and a tick run after the interview both closes
   attendance and sends a reminder about it. Harmless, and visible in the demo walkthrough,
   which says so rather than hiding it.

## Adding a CLI

1. Write `lib/cli/<name>.ts` exporting a `CliSpec` and a `run<Name>(args) => Promise<CliOutput>`.
   Declare **every** flag on the spec: `--help` is generated from it, and
   `tests/modes/consistency.test.ts` checks mode files against that output.
2. Add `bin/<name>.mjs` — three lines, no logic.
3. Reads and writes go through `rt.ports` (ledgered). `rt.raw` is for reconciliation and audit
   reads only. Never `new Date()`: use `rt.now()` / the `now` from `openRuntime`.
4. A decision of record is not a new CLI. It is `propose.mjs` and `decide.mjs`.
