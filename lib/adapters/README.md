# `lib/adapters` — the seam between the engine and the world

The engine (block B1.1) is pure. Everything that touches a file, a tenant or a person happens
here, behind the seven ports in `lib/ports/`. Three modes select them:

| Family                     | `TL_ADAPTER` | State                                                                   |
| -------------------------- | ------------ | ----------------------------------------------------------------------- |
| `lib/adapters/fixture/**`  | `fixture`    | Complete. Runs the demos end to end with no network (the default).      |
| `lib/adapters/rippling/**` | `rippling`   | Stubs with the real call names; every method throws.                    |
| `lib/adapters/bridge/**`   | `bridge`     | **Not a third port family** — a data path. It maps a Rippling MCP       |
|                            |              | snapshot the _agent_ fetched into `TL_DATA_DIR/tier1`, then hands it to |
|                            |              | the fixture port classes above, unchanged.                              |

The bridge exists because the Rippling MCP is agent-executed: its OAuth token lives in the
Claude client, so `bin/*.mjs` cannot call it (`docs/DECISIONS.md` D25). `node bin/bridge.mjs
fetch-plan` prints the `codemode.*` calls to run; `import --from <snapshot.json>` validates,
maps and writes. Because the ports are the same objects in both modes, the engine cannot tell
a real tenant from a fixture one — and the mapping's compromises (no pay, no dated absence, no
teams or levels) are recorded as warnings in `tier1/provenance.json` rather than hidden.

Nothing outside this directory constructs a port. Callers ask for a runtime:

```ts
import { buildRuntime } from '#lib/adapters/index.ts';

const runtime = buildRuntime();                                  // reads the TL_* environment
const runtime = buildRuntime(config, { tickId: 'tick_a1b2c3d4' }); // one correlated tick

await runtime.ports.state.create('task', { … });  // allowlist-checked and ledgered
await runtime.raw.state.list('task');             // unledgered: audit / verify-loops reads only
runtime.now();                                    // the (frozen) clock — never `new Date()`
```

`runtime` also carries `actor`, `policy`, `states`, `config` and — on fixtures — the loaded
`bundle`, so no caller re-reads any of them.

## Fixture adapters: which file, which port, which bytes on disk

| Port           | File                      | Reads / writes                                                        |
| -------------- | ------------------------- | --------------------------------------------------------------------- |
| `graph`        | `fixture/graph.ts`        | `TL_FIXTURES_DIR` (in memory, loaded once). Read-only.                |
| `ats`          | `fixture/ats.ts`          | Same bundle; `readDocument` serves résumés as `UntrustedDocument`.    |
| `bands`        | `fixture/bands.ts`        | Same bundle; computes `compa_ratio = base_annual / band.mid` (3 dp).  |
| `availability` | `fixture/availability.ts` | Same bundle + `tenant/policy.yml quiet_hours`.                        |
| `channel`      | `fixture/channel.ts`      | Appends `TL_DATA_DIR/outbox.jsonl`; reads `TL_DATA_DIR/inbox.jsonl`.  |
| `state`        | `fixture/state.ts`        | `TL_DATA_DIR/state/<kind plural>.json` (atomic write + rename).       |
| `ledger`       | `fixture/ledger.ts`       | Appends `TL_DATA_DIR/ledger.jsonl`. Append and list; no rewrite path. |

`TL_DATA_DIR` is seeded by `node bin/seed.mjs --reset`. A state call against an unseeded
directory throws `RuntimeStateMissingError`, whose message is that command.

Rules the fixture adapters enforce so no caller has to:

- **Ids** are `tl_<kind>_<8 hex>` from `crypto`, assigned on `create` — never `max + 1`.
- **Provenance** (`id`, `created_at`, `created_by`) cannot be patched.
- **Status moves** on `cycle`, `task` and `proposed_action` are checked against
  `templates/loop-states.yml`; an undeclared transition throws `LoopStatesError`.
- **Absence beats everything.** An APPROVED absence or a location holiday means absent
  (`absenceOn`); a PENDING absence does not. Weekends are quiet hours, not absence.
- **Quiet hours** are computed in the worker's _location_ timezone with `Intl.DateTimeFormat`.
- **M2 methods** (`findFreeSlots`, `placeHold`) throw `NotImplementedYetError`, never a fake.

## What a ledger line looks like

`lib/adapters/ledgered.ts` wraps every port except the ledger itself. One line per port call —
reads included (spec §7 step 5) — appended to `TL_DATA_DIR/ledger.jsonl`:

```json
{
  "id": "tl_agent_action_5f3c2ab1",
  "cycle_id": "tl_cycle_h2_2026",
  "ts": "2026-09-02T16:00:00Z",
  "actor": {
    "worker_id": "w_0021",
    "email": "priya.raghunathan@acme-robotics.example",
    "adapter": "fixture"
  },
  "port": "channel",
  "function": "sendDirect",
  "args_hash": "9f2b…",
  "args_summary": "{to_worker_id:w_0044,text:<redacted:212>,template_id:self_review}",
  "result": "ok",
  "result_ref": "msg_1a2b3c4d",
  "permission_context": ["people.read", "absence.read", "…", "slack.send_as_user"],
  "tick_id": "tick_a1b2c3d4"
}
```

- `result` is `ok`, `rejected` (the write allowlist refused it) or `error` (the call threw).
- `result_ref` is the created id when there is one (`id`, `message_ref`, `hold_ref`).
- `args_hash` is sha256 over the canonical (key-sorted) JSON of the argument list — the whole
  argument, hashed, so a line can be checked against a claim without storing the payload.
- `args_summary` is ≤ 120 characters and carries **ids only**: prose becomes `<text:n>` and
  body/PII keys (`text`, `body`, `rationale`, `email`, names, …) become `<redacted:n>`. A
  résumé never reaches the ledger.
- `permission_context` is the acting identity's Rippling permissions, copied per line.

**Writes are gated before the port sees them.** A call is treated as a write when
`PORT_WRITE_FUNCTIONS` declares it _or_ its name starts with a write verb — so a method nobody
allowlisted is rejected rather than waved through as an unknown read. Rejections are appended
with `result: "rejected"` and rethrow `WriteNotAllowedError`, whose message names
`bin/propose.mjs`: the only other path a non-allowlisted action may take.

`ledger.append` is deliberately **not** on the allowlist. The ledger is the record of a call,
not a call the agent elects to make; the wrapper appends unconditionally, including for the
write it just rejected.

## The lock

`lib/lock.ts` — `acquireLock(dataDir, cycleId, { staleMs, owner })` `mkdir`s
`TL_DATA_DIR/locks/<cycle_id>/` and writes `owner.json` (`{ pid, owner, acquired_at }`). A
second acquire throws `LockHeldError` naming the holder; a lock older than `staleMs`
(`TL_LOCK_STALE_MS`, default 10 min) is reclaimed and the handle reports `reclaimed: true`.
`withLock(dataDir, cycleId, opts, fn)` releases in a `finally`.

## Rippling stubs

`rippling/mcp.ts` holds all 31 `codemode.*` functions by name (research 06) plus the ports the
MCP would back (people/org, absence, custom objects). `rippling/rest.ts` holds the REST-only
ports — requisitions, candidates, applications, headcount, comp bands — with their resource
paths. `rippling/index.ts` adds the Slack-backed channel and `buildRipplingPorts()`.

Every method throws `RipplingNotConnectedError`, which names the exact call and points at
`docs/QUESTIONS.md` (Q2 for Rippling, Q3 for Slack/Calendar). `MCP_BACKING`, `REST_BACKING`
and `CHANNEL_BACKING` are the machine-readable map of method → real call;
`delete_custom_record` exists in the stub list because Rippling has it, and appears in no
backing map because engine state is corrected by update, never deleted.

## Adding a real adapter

1. Implement the port interface in `lib/ports/<port>.ts`. Return the Tier-1 types unchanged —
   never invent fields, never copy a Tier-1 value into a `tl_*` record.
2. Put it behind a family directory (`lib/adapters/<system>/`) and add a branch in
   `buildRuntime`. Do not wrap it yourself: `buildRuntime` applies `ledgered` for you.
3. Any new write method must be added to `WRITE_ALLOWLIST` **and** `PORT_WRITE_FUNCTIONS` in
   `lib/safety/allowlist.ts`, with a test that a non-allowlisted sibling is rejected. If the
   action is a decision of record, it does not belong on the allowlist at all — it is a
   `tl_proposed_action` via `bin/propose.mjs`.
4. Free human text comes back as `UntrustedDocument`, never as a plain string.
