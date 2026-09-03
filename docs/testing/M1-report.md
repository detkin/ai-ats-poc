# M1 test report — Engine + review cycle (re-test)

**Verdict: PASS** (13 of 13 checks pass; prior defects D-1 – D-5 all verified fixed or formally
resolved; 0 open defects, 7 observations, none blocking M2).

- Tester: independent M1 tester agent (has not seen builder reasoning).
- Commit under test: `c08c6be` "M1: holidays suppress nudges, keep due dates" on `main`; working
  tree clean before and after.
- Environment: Node v24.5.0, npm 11.19.0, darwin 25.6.0, `TL_ADAPTER=fixture`, no network used.
- Runtime state: a **fresh** temp `TL_DATA_DIR` outside the repo, seeded from scratch. **Every**
  command set `TL_NOW` explicitly. The write-allowlist probe (check 8) ran against a *second*,
  isolated temp `TL_DATA_DIR` so that its deliberately-rejected writes could not contaminate the
  scenario's ledger, which check 10 asserts is free of `cycle_id: null` lines.
- Date of run: 2026-09-02.

This is a full re-run of all thirteen checks, not a spot-check of the fixes. Every claim below was
executed; nothing rests on a builder's assertion or on a tick's own summary. State files,
`outbox.jsonl` and `ledger.jsonl` were read directly for each assertion.

**Prior defects — status**

| id  | Was                                                        | Now                                                                                                                                      |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Nudges fanned out per task: 253 DMs to 86 people, up to 4 each | **Fixed and verified.** 86 DMs to 86 people on tick 1, histogram `{1: 86}`; 253 `tl_nudge` records share the 86 DMs' `message_ref`s; the 48 h gap is now per recipient (D17). |
| D-2 | `decide`/`nudge` ledger lines had `cycle_id: null`, invisible to `audit --cycle` | **Fixed and verified.** **Zero** `cycle_id: null` lines across all 4683 ledger lines after the full scenario; the decision-of-record `state.update`, and a standalone `nudge.mjs --task`'s `sendDirect` + task transition, are all in `audit --cycle` (D19). |
| D-3 | `bin/doctor.mjs` was 79 lines with its own arg parser        | **Fixed and verified.** 12 lines on the shared `runCli`; all ten CLIs are now 12 lines; logic moved to `lib/cli/doctor.ts`.               |
| D-4 | The walkthrough's clock ladder made claims the engine did not produce | **Fixed and verified.** I followed the rewritten ladder exactly; **every** number it quotes was reproduced (see check 6).                 |
| D-5 | `decided_by` vs D10's `decided_by_worker_id`                 | **Resolved by decision.** D10 now carves out the exception explicitly; the field stays `decided_by`. No code change needed; I agree with the call. |
| O-1 | First escalation cited task ids but the mode file promised nudge ids | **Fixed and verified.** The walkthrough now says so in as many words, and the record matches: 111 task ids, 0 nudge ids on the first escalation; 219 + 167 on the second. |

---

## Results

| #   | Check                                                        | Status   | Key evidence                                                                                                                                          |
| --- | ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `npm ci` + `make prepush` green; tree clean afterwards       | **PASS** | exit 0; **30 test files / 535 tests** (was 521); `git status --short` empty                                                                            |
| 2   | `doctor --json` healthy after `seed --reset`                 | **PASS** | `ok: true`, 8 ok / 1 warn (`mcp_servers`, informational) / 0 fail, exit 0                                                                              |
| 3   | Cycle opens at 2026-08-24 with the right tasks + shadows     | **PASS** | 479 tasks (120/240/119), all `pending`/`attempt_n 0`, due 08-24 / 08-31 / 09-07 23:59:59Z, `original_due_at == due_at` on 479/479; 479 pending submissions, 479 distinct keys; 961 ledger lines, actor `w_0021`, 0 with null `cycle_id` |
| 4   | Tick 1 (a–e)                                                 | **PASS** | all five sub-checks pass, including the batching invariants that failed last time                                                                      |
| 4a  |  PTO'd manager: no nudge, moved due date                     | **PASS** | `w_0009`→09-06, `w_0015`→09-11, `w_0033`→2026-11-03; 0 nudge records and 0 DMs each; `w_0072` (PENDING) nudged, 3 tasks, **1** DM                      |
| 4b  |  **One DM per recipient**, shared `message_ref`, policy      | **PASS** | 86 DMs / 86 recipients / max 1 each; 253 `tl_nudge` records over 86 `message_ref`s, all matching a DM, 0 recipient mismatches; every `policy_check.passed: true` with the four sub-flags; 0 BLR nudges of 109 BLR tasks |
| 4c  |  Exactly one escalation with evidence                        | **PASS** | 1 `escalate`/`proposed`, 111 evidence refs, all real task ids, all `escalated`, all 8.7 d overdue; cycle → `escalated`; exactly 1 escalation DM to `w_0021` |
| 4d  |  Anomaly from the injected résumé, and nothing else          | **PASS** | 1 `tl_anomaly`, rule `ignore_prior_instructions`, 191-char excerpt; `cand_0003` appears in no other state file or outbox line                          |
| 4e  |  Ledger completeness, no rejections                          | **PASS** | 0 `rejected`, 0 `error`; every write line carries actor + `permission_context` + `args_hash` + `tick_id`; 0 lines with null `cycle_id`                 |
| 5   | Tick 2 at the same `TL_NOW` is a no-op                       | **PASS** | `changed: false`, 0 actions; `state/*.json` byte-identical; outbox 87→87; +253 ledger lines, **all reads**; anomalies 1→1                              |
| 6   | The walkthrough's clock ladder, claim by claim               | **PASS** | every quoted number reproduced: 86/253, 78/167, 2/5, 0/0 — see the table below                                                                         |
| 7   | Decisions of record only via `propose`/`decide`              | **PASS** | bogus proposal → exit 1; real decide → `approved`+`decided_by`+`decided_at`+note; `propose` changes only `proposed_actions.json`, outbox unchanged; `--kind bogus` → exit 2; one `state.create('proposed_action'` in the tree |
| 8   | Write allowlist enforced and ledgered                        | **PASS** | 4 illegal calls each threw and each appended a `rejected`/`error` line naming `bin/propose.mjs`; no delete on `StatePort`; ledger exposes `append`/`list` only |
| 9   | Calibration packet — citations, hygiene, neutrality, staging | **PASS** | 0 uncited figures; 64 inline tokens fully covered by 59 stored citations; AI disclosure; 0 emails / `$` / bare 5–6-digit numbers; 0 denylist words; `w_0008` 4.75 as an observation; 104/113 lines identical to the golden; 2 partials merged in `section_id` order after the engine body, `inputs_hash` unchanged |
| 10  | `audit.mjs` + `verify-loops.mjs`                             | **PASS** | audit lists **all** 4384 cycle lines and its summary matches my own counts exactly; the `decide` update, the standalone nudge's `sendDirect` and its task update are all present; **0** null-`cycle_id` lines; verify-loops 0 findings, and exits 1 naming the record on both injected drifts |
| 11  | Per-cycle lock: held blocks, stale reclaims                  | **PASS** | fresh `owner.json` → exit 1 naming the holder; `TL_LOCK_STALE_MS=1000` → reclaimed, tick ran, lock released                                            |
| 12  | Thin CLIs and house rules                                    | **PASS** | **all ten** `bin/*.mjs` are 12 lines; lint exit 0; largest file 627 lines; all ten `--help` exit 0 and list flags; `tests/modes/consistency.test.ts` 56/56; SKILL.md 49 lines |
| 13  | Engine purity                                                | **PASS** | `grep -rn "node:fs\|node:process\|process\.\|lib/adapters\|lib/config" lib/engine/` → no matches; only `node:crypto` imported                          |

---

## Evidence

### 1–3. Build, doctor, open

```
$ npm ci && make prepush
 Test Files  30 passed (30)
      Tests  535 passed (535)
$ git status --short
(empty)

$ TL_NOW=2026-09-02T16:00:00Z node bin/seed.mjs --reset      # fresh temp TL_DATA_DIR
$ TL_NOW=2026-09-02T16:00:00Z node bin/doctor.mjs --json
ok: true { ok: 8, warn: 1, fail: 0 }      exit 0
   warn mcp_servers — placeholder: rippling, slack, google-calendar (informational in fixture mode)

$ TL_NOW=2026-08-24T16:00:00Z node bin/cycle.mjs open --cycle tl_cycle_h2_2026 --json
{ "status": "running", "opened_at": "2026-08-24T16:00:00Z", "participants": 120,
  "tasks": 479, "submissions": 479,
  "by_kind": { "write_self_review": 120, "write_peer_review": 240, "write_manager_review": 119 } }
```

Read back from `state/`: 479 tasks, `{pending: 479}`, `{attempt_n 0: 479}`, due dates exactly
120 × 08-24 / 240 × 08-31 / 119 × 09-07 at `23:59:59Z`, `original_due_at == due_at` on all 479.
479 `tl_review_submission` rows, all `pending`, 479 distinct `(author, subject, kind)` keys, 0 rows
naming a non-worker. Ledger: 961 lines — 958 `state.create ok` (479 + 479, every id present as a
`result_ref`), 1 `state.update ok` (cycle → running), 2 reads; actor `w_0021` (the HRBP,
`is_default: true`) on all 961; 0 missing `permission_context`, 0 missing `args_hash`, **0 with a
null `cycle_id`**.

### 4b. One reminder per person — the D-1 fix, verified from the outbox

```
tl_nudge records: 253        outbox lines: 87  (86 nudge DMs + 1 escalation DM)
distinct DM recipients: 86   DMs per recipient histogram: { 1: 86 }
distinct message_refs across nudge records: 86
every nudge message_ref has a DM: true      every DM message_ref has >=1 nudge record: true
nudge -> DM recipient mismatches: 0         tasks with >1 nudge record: 0
nudge record templates: { nudge.multi.first: 245, nudge.write_self_review.first: 8 }
DM templates:            { nudge.multi.first:  78, nudge.write_self_review.first: 8 }
```

78 multi-kind DMs + 8 single-kind DMs = 86, exactly as the walkthrough states. One DM, verbatim:

```
Hi Chidi — 3 item(s) in **H2 2026 Mid-Year Review** are waiting on you:

- peer review of Sean Marchetti — due 2026-08-31
- self review — due 2026-08-24
- peer review of Anders Rossi — due 2026-08-31

That is one reminder for all of them, not one each. The cycle closes 2026-09-18.
…
_Reminder 1 of 3 · sent by the Talent Loops cycle engine._
```

Policy and routing: all 253 records carry `policy_check` `{recipient_in_cycle: true, absent: false,
quiet_hours: false, attempts_ok: true, passed: true, reasons: []}`; 0 recipients outside the cycle's
participant set. Quiet hours: **0** of the 109 tasks held by Bangalore workers were nudged
(`detected.quiet: 109`); recipients were `loc_sf` 48, `loc_nyc` 22, `loc_remote_us` 16. Ledger for
the tick: `channel.sendDirect ok` **87**, `state.create ok` 256, `state.update ok` 402, one tick id.

**Per-recipient 48 h gap**, measured across the 09-02 and 09-04 ticks:

```
distinct per-recipient DM gaps (h): [ 48 ]      recipients with a gap < 48 h: 0
2026-09-02T16:00:00Z  DMs 86  recipients 86  max per recipient 1
2026-09-04T16:00:00Z  DMs 78  recipients 78  max per recipient 1
```

Across the whole scenario, **max 1 DM per recipient per tick instant** at all four nudging instants.

### 4a / 4c / 4d. Absence, escalation, anomaly

| worker   | absence                    | expected  | observed `due_at`        | nudge records | DMs |
| -------- | -------------------------- | --------- | ------------------------- | ------------- | --- |
| `w_0009` | PTO → 09-03, returns 09-04 | 09-06     | **2026-09-06T23:59:59Z**  | 0             | 0   |
| `w_0015` | PTO → 09-08, returns 09-09 | 09-11     | **2026-09-11T23:59:59Z**  | 0             | 0   |
| `w_0033` | Parental → 10-31           | 11-03     | **2026-11-03T23:59:59Z**  | 0             | 0   |
| `w_0072` | PTO **PENDING**            | unchanged | unchanged                 | 3             | 1   |

`original_due_at` unchanged on every moved task; all 37 `move_due_date` reasons read `participant
absent until <date> (<leave type>); +2 day(s) per policy`.

Escalation: one `tl_proposed_action_1251906b`, `escalate`, `proposed`, 111 evidence refs — all real
task ids, all `status: escalated`, all `write_self_review` 8.7 days overdue; the escalated-task count
is exactly 111; **0** nudge ids among them, which is now what the walkthrough says. Cycle →
`escalated`. Exactly one escalation DM, to `w_0021`.

Anomaly: one record, `rule: ignore_prior_instructions`, 191-char excerpt.
`grep -ro "cand_0003\|app_0003" state/ outbox.jsonl` → a single hit, the anomaly record itself.

### 5. Idempotence

```
$ TL_NOW=2026-09-02T16:00:00Z node bin/tick.mjs … --scan resumes/cand_0003.md --json
changed: false   actions: 0   nudges: 0   nudged_tasks: 0   escalations: 0
```

`sha256` of all ten state files: identical before/after. Outbox 87 → 87. Anomalies 1 → 1. Ledger
+253 lines, **every one a read** (`state.get/list`, `graph.*`, `availability.*`, `ats.readDocument`,
`bands.listBands`); 0 create/update/send/post; 0 with a null `cycle_id`.

### 6. The walkthrough's clock ladder, followed exactly as written

| step                     | the walkthrough claims                                                    | observed                                                                   |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 09-02 16:00Z             | `nudges: 86`, `nudged_tasks: 253`, 78 × `nudge.multi.first`, 8 self-only  | **86 / 253 / 78 / 8** ✓                                                    |
| 09-02 16:00Z             | `detected.quiet: 109` (nobody in Bangalore)                               | **109**, 0 BLR nudges ✓                                                    |
| 09-02 16:00Z             | `move_due_date: 37`; `w_0009` → 09-06; `w_0072` nudged                    | **37**; 09-06; nudged ✓                                                    |
| 09-02 16:00Z             | one escalation, 111 offenders, evidence = 111 task ids, no nudge ids      | **1 / 111 / 111 task ids / 0 nudge ids** ✓                                 |
| 09-02 16:00Z (2nd run)   | `changed: false`, zero actions, no 2nd escalation, no 2nd anomaly         | ✓ (byte-identical state)                                                   |
| 09-04 16:00Z             | `nudges: 78`, `nudged_tasks: 167`, all `…followup`, all `attempt_n: 2`    | **78 / 167**, all `nudge.write_peer_review.followup`, `attempt_n` set `[2]` ✓ |
| 09-04 16:00Z             | second `escalate` over 219 tasks, evidence overlap zero                   | 386 refs = **219 tasks + 167 nudges**, overlap **0** ✓                     |
| **09-07 06:00Z**         | `nudges: 2`, `nudged_tasks: 5`, `move_due_date: 0`                        | **2 / 5 / 0** ✓                                                            |
| **09-07 06:00Z**         | `w_0009`'s *first* reminder, `nudge.write_self_review.first`, `attempt_n: 1`, their 8 manager reviews **not** in it | one DM to `w_0009`, that template, `attempt_n 1`, `task_ids` length **1** ✓ |
| **09-07 06:00Z**         | two Bangalore recipients in total                                         | `w_0067` and `w_0009`, both `loc_blr`; 4 + 1 = 5 tasks ✓                    |
| **09-07 16:00Z**         | Labor Day: zero nudges, zero `move_due_date`, every `due_at` untouched    | `changed: false`, 0 actions, `absent: 374`, `quiet: 479`; **all 479 `(id, due_at, original_due_at)` triples byte-identical, and all ten state files byte-identical** ✓ |
| ladder-wide              | "no task ever reaches attempt 3"                                          | attempt histogram `{0, 1, 2}`, **max 2**, cap 3 ✓                          |

The D20 claim specifically: the 09-07 06:00Z tick recorded **374 workers absent** (US Labor Day at
`loc_sf`, `loc_nyc`, `loc_remote_us`) and produced **`move_due_date: 0`**, with every `due_at`
unchanged — and the 16:00Z tick on the same day did the same with zero writes at all. Approved leave
still moves dates (37 moves on tick 1). Holiday quiets; leave moves. Verified both ways.

A representative attempt ladder, showing the DM identity changing while the task ladder advances:

```
task tl_task_70eb1e51   attempt_n 2   nudged_at 2026-09-04T16:00:00Z
   attempt 1  2026-09-02T16:00:00Z  nudge.multi.first                msg_d66dfe9e
   attempt 2  2026-09-04T16:00:00Z  nudge.write_peer_review.followup msg_5245d593
```

### 7. Decisions of record

```
$ node bin/decide.mjs --proposal tl_proposed_action_deadbeef …      exit 1
$ TL_NOW=2026-09-03T16:00:00Z node bin/decide.mjs --proposal tl_proposed_action_1251906b \
    --by w_0021 --decision approve --note "seen" --json
{"status":"approved","decided_by":"w_0021","decided_at":"2026-09-03T16:00:00Z",
 "note":"seen","updated_at":"2026-09-03T16:00:00Z"}                  exit 0
$ node bin/propose.mjs --kind set_rating …   → tl_proposed_action_a9805c38 proposed, exit 0
$ node bin/propose.mjs --kind bogus …        → exit 2
```

State diff after the `propose` calls names exactly one file, `state/proposed_actions.json`; the
outbox stayed at 168 lines. One creation path in the tree:
`lib/cli/propose.ts:116: return rt.ports.state.create('proposed_action', {`.

### 8. Write allowlist (isolated data dir)

| attempt                               | result                                                                                         | ledger                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| `state.create('worker', …)`           | `WriteNotAllowedError: … outside the write allowlist. Record it as a tl_proposed_action via bin/propose.mjs …` | `state.create` **rejected**   |
| `state.update('worker', 'w_0001', …)` | `WriteNotAllowedError` (same message)                                                          | `state.update` **rejected**   |
| `state.create('tl_evil', …)`          | `TalentLoopsError: "tl_evil" is not a tl_* state kind`                                         | `state.create` **error**      |
| `availability.placeHold({})`          | `NotImplementedYetError … lands in M2`                                                         | `availability.placeHold` **error** |

`ats.createRequisition`, `ats.createDraftHire` and `channel.someOtherWrite` are all `undefined` on
the ports. `StatePort` methods: `assertKnownStatus, create, get, list, now, pathFor, readAll,
update` — **no delete of any name**. Ledger port functions: **`append`, `list`** (plus a `now` clock
helper). No port can rewrite the ledger.

### 9. Calibration packet

```
lines with a digit and no citation: 7   → the title, the assembled-at header, and the five ## headings
emails: 0 | $ amounts: 0 | bare 5-6 digit numbers: 0 | denylist hits: none
inline tokens: 64 | stored citations: 59 | distinct record ids: 757 | inline ids missing: 0
AI disclosure: true
- Manager `w_0008` has a prior-cycle mean of 4.75 across 8 rated reports, 1.07 above the
  company mean of 3.68. [prior_ratings:w_0032,…,w_0039]
```

Golden diff: **104 of 113 lines identical**. The 9 differing lines are the assembly timestamp and
the eight §4 "Submitted" figures, which differ because the golden's scenario
(`tests/engine/packet.test.ts`) marks every Engineering self review `submitted` at `2026-09-03`,
whereas the demo run has none submitted. Every line the golden's scenario actually covers matches.

Staging: two partials re-assembled with `--staging <dir>` gave `partials: ["a_first","z_second"]`,
rendered under `## Contributed sections` **after** `## 5. Observations`, in `section_id` order, with
citations merged (`{derived: 59, source: 2}`) and the `inputs_hash` unchanged. The walkthrough's own
step-5 command (`--staging staging`, `TL_NOW=2026-09-07T06:00:00Z`) also runs clean.

### 10. Audit and verify-loops — the D-2 fix, verified end to end

```
$ node bin/audit.mjs --cycle tl_cycle_h2_2026 --format json
summary: total 4384, reads 2029, writes 2355 (state 2186, channel 169),
         rejected 0, errors 0, ticks 5, actors [w_0021],
         window 2026-08-24T16:00:00Z → 2026-09-08T06:00:00Z

my own pass over ledger.jsonl: total 4384, writes 2355, reads 2029,
         state 2186, channel 169, rejected 0, errors 0, ticks 5, actors [w_0021]
ledger file lines: 4384   |   lines with cycle_id null: 0
audit entries: 4384  ==  every line in the file
```

The three writes that were invisible last time are all present and cycle-scoped:

```
state.update  ok  cycle_id=tl_cycle_h2_2026  result_ref=tl_proposed_action_1251906b
              args_summary="proposed_action … {status:approved,decided_by:w_0021,decided_at:…"
channel.sendDirect ok cycle_id=tl_cycle_h2_2026 result_ref=msg_7fb070bc   (standalone nudge.mjs --task)
state.update  ok  cycle_id=tl_cycle_h2_2026  result_ref=tl_task_07549b03  (its task transition)
```

After the *entire* scenario — 7 tick runs, a decide, two standalone `nudge.mjs --task` runs, three
packet assembles, a lock-reclaim tick — the ledger holds **4683 lines and 0 with a null `cycle_id`**,
0 rejected, 0 errors, and 0 write lines missing actor / `permission_context` / `args_hash`.

`verify-loops`:

```
$ node bin/verify-loops.mjs --cycle tl_cycle_h2_2026 --json    ok: true, 3158 checks, 0 findings, exit 0
$ (hand-edit a nudged task to "done")                          exit 1
     FAIL done_task_has_submission — names tl_task_9e107dfb
$ (restore)                                                    exit 0
$ (append tl_nudge_fa11fa11 → tl_task_doesnotexist)            exit 1
     FAIL state_records_ledgered — names tl_nudge_fa11fa11
$ (restore)                                                    exit 0
$ (final, after everything above)                              exit 0
```

### 11. Lock

Fresh `owner.json` → `tick.mjs: cycle "tl_cycle_h2_2026" is locked by tester-manual (pid 99999,
since 2026-09-08T05:59:59Z), 1s old. …`, exit 1. `acquired_at` back-dated with
`TL_LOCK_STALE_MS=1000` → reclaimed, tick ran (`changed: true`), lock directory released.

### 12. Thin CLIs and house rules

All ten `bin/*.mjs` are **12 lines** — a header comment, two imports, one
`runCli(SPEC, argv, run)`. `bin/doctor.mjs` now reads exactly like the other nine, with its logic in
`lib/cli/doctor.ts`. `npm run lint` exit 0. Largest file 627 lines (`tests/engine/plan.test.ts`),
under the 650 cap. All ten `--help` exit 0 and list 2–9 flags.
`tests/modes/consistency.test.ts` 56/56 against the real CLIs. SKILL.md 49 lines.

Doctor's exit codes behave as its own note documents: bad argument → **2**; invalid `TL_ADAPTER` →
**1**; a failing check (`TL_FIXTURES_DIR=/nonexistent`) → **1** with `ok: false`.

### 13. Engine purity

`grep -rn "node:fs\|node:process\|process\.\|lib/adapters\|lib/config" lib/engine/` → no matches.
The only non-`#lib` import in `lib/engine/` is `createHash` from `node:crypto`.

---

## Demo readiness

**The spec §8 loop-1 story now holds end to end, and the walkthrough is a script you can read aloud.**

I followed `modes/review-cycle.md`'s ladder exactly as written and every number it quotes came back:
86 DMs for 253 overdue reviews, 109 quiet in Bangalore, 37 moved due dates, one escalation over 111
offenders; a byte-identical second tick; 78 follow-ups on 09-04 with a second escalation whose
evidence overlaps the first by zero; then the 06:00Z India tick where `w_0009` — back from PTO, past
their moved deadline, 11:30 on a Monday in Bangalore — gets their **first** reminder, one DM, one
task, while the eight manager reviews due later that day stay out of it; and finally the Labor Day
tick that writes nothing at all and leaves all 479 due dates byte-for-byte where they were.

The two things that would have been noticed in a live demo are gone. A participant's Slack now shows
**one** message listing their items as bullets, with the line "That is one reminder for all of them,
not one each" doing the arguing for you. And "where is the HRBP's approval in the audit trail?" is
now answerable by pointing at `audit.mjs --cycle`: it holds every one of the 4384 lines for this
cycle, the decision-of-record `state.update` among them, and there is not a single ledger line in the
run that a cycle audit would miss.

The safety story is intact and demonstrable rather than asserted: an out-of-allowlist write throws
with a message naming `propose.mjs` and lands as a `rejected` line; the state port has no delete and
the ledger port has no rewrite; the injected résumé produces an anomaly and nothing else; a
calibration packet with 64 cited figures, no emails, no pay amounts and no verdict language;
`verify-loops` green on the real run and loud on both injected drifts.

Nothing in this run blocks M2. The observations below are worth a glance before the demo — O-1 in
particular, because an operator following step 4's `bin/nudge.mjs --task` advice can quietly burn a
recipient's 48-hour window.

---

## Defects

**None open.** D-1, D-2, D-3, D-4 and O-1 are verified fixed by execution (see the status table at
the top); D-5 was resolved by amending D10, which now records the `decided_by` exception explicitly.

## Observations (not defects)

- **O-1 — `nudge.mjs --task` consumes the recipient's whole 48 h window.** `--task` is "a bundle of
  one" (`lib/cli/README.md`), so nudging one of a person's tasks sends a DM covering only that task
  and sets the per-recipient gap for all of them. Observed: a manual nudge to `w_0012` covered 1 of
  their 5 eligible manager reviews, and the tick that ran at the same instant then correctly skipped
  `w_0012` entirely (`nudge_gap_not_elapsed`) while nudging `w_0013` and `w_0014`. Their other four
  reviews are now silent for 48 h. This is the batching rule working as designed, and it is also a
  sharp edge for an operator; `modes/review-cycle.md` step 3 offers the command without the caveat.
- **O-2 — all 59 calibration citations are `kind: derived`.** `source` is implemented
  (`packet-sections.ts:38`) but never emitted. Defensible — every figure in the packet is an
  aggregate — but spec §5 says joins are `source`, and the mode file's `source` example (a
  per-worker compa-ratio citing the worker and the band) does not appear in the body at all.
- **O-3 — `ats.createDraftHire` is on `WRITE_ALLOWLIST` but no adapter implements it.** Correct for
  M1 (it is M3's path); the allowlist currently advertises a write that does not exist yet.
- **O-4 — `tick_id` is a 64-hex content hash, so two ticks over identical inputs share it.**
  `lib/adapters/README.md` still illustrates `tick_a1b2c3d4`. Consequence: the no-op second tick
  appended 253 read lines under tick 1's id, and `audit`'s "distinct ticks: 5" counts seven tick runs
  as five. Deterministic and arguably right, but not what the README shows.
- **O-5 — `audit`'s `last_ts` is the last *appended* line's timestamp, not the maximum.** It happened
  to be the maximum this run. Under `TL_NOW` back-dating (a packet assembled at an earlier clock
  after a later tick) it will read as earlier than the newest event.
- **O-6 — the generic exit-code line in every `--help` contradicts doctor's own note.** `args.ts`
  prints "Exit codes: 0 success, 1 domain failure …, 2 usage or config" for all ten CLIs, and
  doctor's next paragraph correctly says an invalid `TL_*` is exit 1 for doctor. The behaviour is
  right and deliberate (`lib/cli/doctor.ts` header); only the boilerplate line above it is
  misleading.
- **O-7 — `tests/engine/plan.test.ts` is 627 lines**, the largest file in the repo and 23 lines under
  the 650 cap. M2 adds plan cases; it will want splitting before it does.

---

## Commands run (for reproduction)

```sh
export TL_DATA_DIR=<fresh tmp>
npm ci && make prepush && git status --short
TL_NOW=2026-09-02T16:00:00Z node bin/seed.mjs --reset
TL_NOW=2026-09-02T16:00:00Z node bin/doctor.mjs --json
TL_NOW=2026-08-24T16:00:00Z node bin/cycle.mjs open --cycle tl_cycle_h2_2026 --json
TL_NOW=2026-09-02T16:00:00Z node bin/tick.mjs --cycle tl_cycle_h2_2026 --scan resumes/cand_0003.md --json   # ×2
TL_NOW=2026-09-04T16:00:00Z node bin/tick.mjs --cycle tl_cycle_h2_2026 --json
TL_NOW=2026-09-07T06:00:00Z node bin/tick.mjs --cycle tl_cycle_h2_2026 --json
TL_NOW=2026-09-07T16:00:00Z node bin/tick.mjs --cycle tl_cycle_h2_2026 --json
TL_NOW=2026-09-03T16:00:00Z node bin/decide.mjs --proposal tl_proposed_action_deadbeef --by w_0021 --decision approve
TL_NOW=2026-09-03T16:00:00Z node bin/decide.mjs --proposal tl_proposed_action_1251906b --by w_0021 --decision approve --note "seen" --json
TL_NOW=2026-09-03T16:00:00Z node bin/propose.mjs --cycle tl_cycle_h2_2026 --kind set_rating --payload '…' --rationale '…' --evidence w_0044 --json
TL_NOW=2026-09-03T16:00:00Z node bin/propose.mjs --cycle tl_cycle_h2_2026 --kind bogus … --json
TL_NOW=2026-09-08T06:00:00Z node bin/tick.mjs --cycle tl_cycle_h2_2026 --dry-run --json
TL_NOW=2026-09-08T06:00:00Z node bin/nudge.mjs --task <picked> --json
TL_NOW=2026-09-02T16:00:00Z node bin/packet.mjs assemble --cycle tl_cycle_h2_2026 --kind calibration --json
TL_NOW=2026-09-02T16:00:00Z node bin/packet.mjs show --packet <id> --json
TL_NOW=2026-09-02T16:00:00Z node bin/packet.mjs assemble … --staging <tmp>/staging --json
TL_NOW=2026-09-07T06:00:00Z node bin/packet.mjs assemble … --staging staging --json
TL_NOW=2026-09-08T06:00:00Z node bin/audit.mjs --cycle tl_cycle_h2_2026 --format json
TL_NOW=2026-09-08T06:00:00Z node bin/verify-loops.mjs --cycle tl_cycle_h2_2026 --json
# lock: fresh owner.json → exit 1; back-dated + TL_LOCK_STALE_MS=1000 → reclaimed
# allowlist probe: buildRuntime() against a second, isolated temp TL_DATA_DIR
```

No source file, fixture, template or config was modified. The only writes were to the two temp
`TL_DATA_DIR`s and to this report.
