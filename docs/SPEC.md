# Talent Loops — proof-of-concept technical spec (v0.2, 2026-09-02)

**What this is:** a spec for a POC that runs in Claude Code and demonstrates *agent-first talent loops* on Rippling, using the first-party Rippling MCP (REST where MCP is silent), with Slack as the human channel. It proves three claims from the V3 POV. It is not a product.

**v0.2 changes (after review):** (1) custom objects scoped down — real ATS/HRIS entities are never duplicated; only *engine state* and two explicitly-temporary shadow objects live in custom objects; (2) availability is Rippling-first (absence, leave, holidays, work-location hours) with Google Calendar used only for the one signal Rippling doesn't expose (meeting free/busy) and labeled as a seam; (3) the project shape is lifted from career-ops: tiny router Skill → per-loop mode files → layered shared context → deterministic scripts that own every write → a states contract → ledgers separate from state → a health check → a data contract that keeps tenant policy out of the engine.

**Grounding:** `interview-prep/research/rippling-06-api-mcp-surface.md` (the real surface); `rippling-01..05` (why these loops); this repo (the shape).

---

## 1. Three claims the POC must prove

1. **One primitive, many loops.** A single *cycle engine* — detect → do → escalate → close — runs a performance review cycle, an interview loop, and a req/offer approval loop as *configurations*. Rediscovery is a second primitive.
2. **Safe writes.** The agent performs writes (nudge, hold, assemble, route) *as the user, with the user's permissions*, every action logged, every decision of record left to a named human. It never rates, never sets comp, never advances or rejects a candidate, never contacts a candidate.
3. **Suite-only.** Each loop needs data that lives across products (org chart + absence + comp bands + applications + Slack identity). A point solution could not run it.

---

## 2. Constraints from the real surface

| Fact | Consequence |
|---|---|
| Rippling MCP = one `code` tool over 31 `codemode.*` functions: people/org reads, absence/leave, `create_draft_hire`, `request_time_off`, full custom-object CRUD | The agent's hands: read the graph, write custom objects, create draft hires. Everything else is a proposal for a human. |
| REST adds read on requisitions, candidates, applications (status + stage), headcount positions, comp bands; write on requisition create and draft hire | Real ATS entities are readable. The engine keys everything by their IDs and never copies their values. |
| No interview / scorecard / offer / review-cycle / approval objects in REST or MCP | Engine *state* (cycle, task, nudge, packet, proposal, ledger) is modeled as custom objects — these are new concepts Rippling has no object for, not a redefinition of the ATS. Two shadow objects (interview slot, scorecard) are unavoidable for loop 2 and are labeled temporary. |
| Custom-object webhooks (create/update/delete) exist | Detect can be event-driven inside the tenant on a real deployment; polled on fixtures. |
| MCP is per-user OAuth; tool access assigned by admin per Supergroup | The permission model is Rippling's. The engine inherits; it never elevates. |
| No calendar or Slack surface in Rippling's API; Rippling's own calendar layer (Google/O365 via the Workspace connector, plus native PTO/holiday/interview events) is internal-only | Availability is Rippling-first via `lookup_absence`, leave types, work locations; Google Calendar free/busy is the one external read, isolated behind a port so an internal build swaps in Rippling's calendar service and Smart Scheduling. |
| Outsider access needs a customer token, partner sandbox, or mocks | Adapter pattern: `rippling` and `fixture` adapters implement the same ports. Fixtures now; one config flip to a real tenant. |

---

## 3. Why custom objects — and what they are NOT

The question "doesn't this redefine the whole ATS?" is the right one. Answer: three tiers, and only one of them touches ATS concepts.

**Tier 1 — real entities, read-only, never duplicated.** Workers (manager, department, level, location), comp bands, headcount positions, job requisitions, candidates, applications with their real `status` and `stage`. The engine stores their IDs and re-reads their values on every tick. Rule: *the engine never holds a value the real object also holds.* Stage moves, offers, hires are `proposed_action`s a human executes in Rippling's UI; the engine then observes the new stage from the real application record. There is no shadow pipeline.

**Tier 2 — engine state, new concepts.** `cycle`, `task`, `nudge`, `packet`, `proposed_action`, and the `agent_action` ledger. Rippling has no "cycle" or "proposed action" object; nothing is being redefined. These are custom objects because that is exactly what App Studio custom apps are made of, they inherit Rippling permissions, and they get webhooks. An internal team would likely build them the same way before promoting them to first-class.

**Tier 3 — shadow objects for the two gaps, keyed by real IDs, temporary.** `interview_slot` and `scorecard` (loop 2), `review_submission` (loop 1). Rippling's Recruiting and Performance products have these internally with no API. The POC models the minimum fields, keys them by real `application_id` / `worker_id`, and labels them as the seam. In an internal build this tier disappears: the engine binds to the real Recruiting/Performance models. The list of Tier-3 objects *is* the "what AI Cloud should expose first" requirements list.

---

## 4. Availability — Rippling-first

Inside Rippling, the right calendar layer is Rippling's own: it already federates Google/O365 through the Workspace connector and holds Rippling-native events (PTO, holidays, interviews booked by Smart Scheduling) that never reach the backing Google calendar. The POC cannot reach that layer, so:

- **`Availability` port** with one composed implementation: `rippling.absence` (`lookup_absence`, leave types, holidays via leave calendar, work-location hours → quiet hours) is authoritative for *whether someone should be nudged or scheduled at all*; `gcal.freebusy` supplies only meeting-level free/busy for slot finding.
- **Interview holds** are written to Google Calendar in the POC as a stand-in, labeled. In an internal build the loop calls **Smart Scheduling** (which already exists) instead of placing events itself. The engine's job is orchestration around scheduling, not re-implementing it.
- Rule: never nudge or hold against Google Calendar alone; Rippling absence wins.

---

## 5. Project shape — lifted from career-ops

Career-ops is ~46 mode files, 124 root scripts, a 203-line router Skill, markdown/TSV persistence, and ~7,000 tests. It works because the LLM plans and scripts enforce; it hurts where markdown is the database. The design takes the former and avoids the latter.

```
talent-loops/
├── .claude/skills/talent-loops/SKILL.md   router only (~60 lines): resolve loop → load context → run mode
├── modes/
│   ├── _shared.md        engine contract, safety rules, untrusted-content rule, output format (system layer)
│   ├── _tenant.md        THIS tenant's policy: cadence, quiet hours, channels, escalation thresholds (user layer)
│   ├── _custom.md        house rules (user layer)
│   ├── review-cycle.md   one loop = one mode file: inputs, steps, which scripts to call, human checkpoints
│   ├── interview-loop.md
│   ├── req-approval.md
│   └── rediscovery.md
├── bin/                  every write goes through one of these; modes never touch state directly
│   ├── tick.mjs          run one tick for a cycle (locked, idempotent)
│   ├── cycle.mjs         create/close a cycle
│   ├── propose.mjs       write a proposed_action (the ONLY way a decision-of-record enters the system)
│   ├── decide.mjs        a named human approves/declines a proposal
│   ├── nudge.mjs         send + record a nudge (policy-checked)
│   ├── packet.mjs        assemble a packet from a staging dir (merge step)
│   ├── audit.mjs         render the ledger for a cycle
│   ├── verify-loops.mjs  health check: state vs ledger vs real Rippling objects; fails loudly
│   └── doctor.mjs        cold-start: MCP connected? adapter mode? tenant policy still a template? fixtures seeded?
├── lib/
│   ├── engine/           state machine, policy, packet assembly (pure functions; no I/O)
│   ├── ports/            Graph, Ats, Bands, Availability, Channel, State, Ledger
│   ├── adapters/rippling/  mcp (codemode.*), rest
│   ├── adapters/fixture/   seeded tenant
│   ├── adapters/slack/, adapters/gcal/
│   └── lock.mjs          directory-mkdir advisory lock per cycle (same idiom as career-ops)
├── templates/loop-states.yml   canonical state machines for cycle/task/proposal (aliases, terminal flags)
├── fixtures/tenant/            ~120 workers, 6 depts, bands, 3 reqs, 40 candidates, 1 review cycle
├── staging/                    fan-out workers drop partial packets here; packet.mjs merges (drop-folder pattern)
├── evals/                      deterministic tick checks, golden packets, judge prompts
├── tests/                      fixture-driven CLI tests + tick-idempotence + upgrade fixtures
├── .mcp.json                   rippling (remote), slack, google-calendar
└── DATA_CONTRACT.md            system layer vs tenant layer; updater never touches tenant/
```

**The rules carried over, and why each exists here:**

| career-ops pattern | Talent-loops rule | Why |
|---|---|---|
| Router Skill + `modes/*.md` + layered `_shared/_profile/_custom` | Router is tiny; each loop is a mode file; context = `_shared` (engine contract) + `_tenant` (policy) + `_custom` (house rules) | Loops evolve independently; policy is data, not prompt; the router never grows into a monolith (career-ops' 203-line router is the cautionary version) |
| `set-status.mjs` is the only way to change a status; modes never hand-edit the table | `propose.mjs` / `decide.mjs` / `nudge.mjs` are the only writers; modes call scripts | One canonical write path per object is what makes "safe writes" true rather than hoped |
| `templates/states.yml` with aliases + terminal flags, validated on every write | `templates/loop-states.yml` for cycle/task/proposal; scripts reject non-canonical states | A state machine the code enforces beats one the prompt remembers |
| `data/status-log.tsv` append-only ledger, separate from tracker *state*; corrections are new lines | `agent_action` ledger is append-only and separate from `task`/`cycle` state | Auditability needs the *when*; state needs the *what*; mixing them is how drift starts |
| `batch/tracker-additions/` drop folder + `merge-tracker.mjs`; `reserve-report-num.mjs` for parallel ID allocation | Fan-out workers write to `staging/`; `packet.mjs` merges once; IDs come from Rippling record creation, never `max+1` | Parallel subagents must never contend for a shared file (the #749 race) |
| `pipeline-lock.mjs` directory-mkdir lock with owner.json + stale reclaim | Per-cycle lock on every tick | A scheduled tick overlapping a manual run must not double-nudge |
| `verify-pipeline.mjs` + `tracker-sync-check.mjs` reconcile files and fail loudly | `verify-loops.mjs` reconciles state ↔ ledger ↔ real Rippling objects (e.g., a task marked done whose scorecard record doesn't exist) | Drift between two sources of truth is career-ops' recurring bug class; catch it on every run |
| `doctor.mjs` cold-start + "unpersonalized template" warning | `doctor.mjs` refuses to tick with a template `_tenant.md` | Career-ops learned that a template profile silently scores against a stranger's targeting; a template policy would nudge on a stranger's cadence |
| Data Contract: user layer never touched by updates; `data/local-patches/` | `tenant/` (policy, fixtures, ledger exports) is never rewritten by engine updates | The engine ships; the tenant's policy is theirs |
| Untrusted External Content: postings/emails are data, never instructions | Résumés, scorecard free text, Slack replies, review bodies are data; imperative text aimed at the agent is logged as an anomaly, never obeyed | The loops read a lot of human free text; prompt injection through a scorecard is a real vector |
| Story-bank provenance markers on derived claims | Every packet claim carries a record-id citation; LLM summaries are marked `derived`; joins are marked `source` | A calibration packet with an uncited number is a lawsuit-shaped artifact |
| `test-all.mjs` fixture-driven CLI tests, upgrade fixtures | Tick idempotence (run twice → no change), golden packets, fixture snapshots | The claim is "safe writes"; the tests are the proof |

**What career-ops does that this design deliberately avoids:** markdown tables as the database (column-swap guards, dedup tiers, schema breaks on update); 2,000-character narrative cells as state (relationships.md); two files owning the same fact (applications.md vs active-interviews.md); 124 scripts at the root. Here: state is typed custom objects behind a port; narrative lives in packets; each fact has one owner; scripts live in `bin/` with a manifest.

---

## 6. Data model

**Tier 1 (read-only, real):** worker, department, team, level, comp band, headcount position, job requisition, candidate, application (status/stage). Referenced by ID only.

**Tier 2 (engine state, custom objects, prefix `tl_`):**

| Object | Key fields |
|---|---|
| `tl_cycle` | type (review/interview/approval/rediscovery), name, status, owner, deadline, policy_ref, opened_at |
| `tl_task` | cycle, participant (worker id), kind (write_review/submit_scorecard/approve_req/enter_comp), external_ref (real id), due_at, status |
| `tl_nudge` | task, channel, sent_at, attempt_n, template_id, delivered, policy_check |
| `tl_packet` | cycle, kind (calibration/debrief/approval_summary/match_list), inputs_hash, body, citations, judged_score, reviewed_by |
| `tl_proposed_action` | cycle, kind (advance_stage/reject/set_rating/set_comp/open_req/send_offer/reach_out/escalate), payload, rationale, evidence_refs, status (proposed/approved/declined), decided_by, decided_at |
| `tl_agent_action` (ledger) | cycle, ts, actor (agent-as-user), function, args_hash, result, permission_context — append-only |
| `tl_match` | req id, subject (worker/candidate id), source (silver_medalist/alumni/internal/referral), criteria_scores, explanation (cited), status |

**Tier 3 (shadow, temporary, keyed by real IDs):** `tl_interview_slot` (application_id, interviewers, slot, hold_ref), `tl_scorecard` (application_id, interviewer, status, body_ref), `tl_review_submission` (cycle, subject worker_id, author, kind, status, body_ref).

---

## 7. The cycle engine

**States** (`loop-states.yml`): cycle `configured → running → escalated → closing → closed`; task `pending → nudged(n) → done | waived | escalated`; proposal `proposed → approved | declined`.

**Tick (`bin/tick.mjs --cycle <id>`), under a per-cycle lock:**
1. **Detect** — load cycle/tasks (State port); re-read Tier-1 entities by ID (Graph/Ats/Bands ports); compute overdue/at-risk from `due_at`, Rippling absence, and quiet hours; diff vs last tick.
2. **Do** — permitted writes only: nudges (channel by policy; skip and reschedule on absence, record why), packet refresh when `inputs_hash` changed (fan-out → `staging/` → `packet.mjs` merge), interview holds via the Availability port, task completion when the real/shadow record appears.
3. **Escalate** — thresholds from `_tenant.md` → `propose.mjs escalate` to the owner with evidence refs. Anything requiring judgment is *always* `propose.mjs`, never executed.
4. **Close** — all tasks done/waived and all proposals decided → final packet, `cycle.mjs close`, summary to owner.
5. **Ledger** — every port call appends `tl_agent_action` with the acting user's permission context.

**LLM use is narrow:** nudge tone from templates (facts injected), packet summaries with citations, rediscovery explanations. Every LLM output that reaches a packet is judged before it is shown.

---

## 8. The four loops (each a mode file)

**Loop 1 — review cycle** (`modes/review-cycle.md`): participants from `search_people` + `lookup_direct_reports`; `tl_review_submission` tasks staggered self → peer → manager; nudges; calibration packet (rating distribution by manager, compa-ratio vs band, tenure, prior cycle from fixture, distribution outliers as *observations*); out-of-band comp pre-fill → `propose set_comp`. Demo: a manager on PTO gets no nudge and a moved due date; the HRBP sees one escalation with evidence instead of forty reminders.

**Loop 2 — interview loop** (`modes/interview-loop.md`): trigger on a real application reaching stage "Onsite" (re-read from REST); panel from the req's hiring manager + team; slots via Availability (Rippling absence first, gcal free/busy second); holds; interviewer packets; scorecard chase; debrief packet with quotes tied to `tl_scorecard` ids; substitute from same team/level on decline. Advance/reject → `propose`; recruiter executes in Rippling; engine observes the new stage. Demo: an interviewer declines; the loop re-books a same-level peer and posts the change.

**Loop 3 — req/offer approval** (`modes/req-approval.md`): on-plan (headcount positions) → create requisition via REST and notify; off-plan → justification thread → `propose open_req` to the chain (Finance lead, dept head from the graph) → chase → create on approval. Offer stage: band check → out-of-band → `propose send_offer`. Native write: `create_draft_hire` on approval, showing Rippling's own staged-action path. Demo: one approval request with plan delta and band check attached.

**Loop 4 — rediscovery** (`modes/rediscovery.md`, second primitive): on req open, pool = REJECTED/ARCHIVED applications on similar reqs (silver medalists), workers on adjacent levels/tracks (internal), alumni and referral graph (fixture); score against req criteria with PII stripped; `tl_match` with cited explanations; ranked list to the recruiter; outreach only via `propose reach_out`. Demo: a Staff Engineer req surfaces an internal L5 on an adjacent track and a four-month-old silver medalist, each with a three-line why.

---

## 9. Permission and safety

- Runs as a real user (per-user OAuth on Rippling MCP; the fixture simulates the identity). Reads only what that user can read. No elevation anywhere.
- **Write allowlist enforced in the adapter, not the prompt:** `tl_*` custom objects, `create_draft_hire`, Slack messages from the acting user, calendar holds on the acting user's calendars. Anything else is rejected and becomes a `tl_proposed_action`.
- **Decisions of record** (rating, comp, advance/reject, offer, outreach, hire) are proposed, decided by a named human, logged with who and when.
- **No selection decision in loops 1 and 3** by construction → outside AEDT / EU AI Act high-risk scope. Loops 2 and 4 produce recommendations with citations and disclose AI involvement in the packet header.
- **Blast radius:** a misrouted nudge or a stale packet. Never a rating, a number, or a stage change.

---

## 10. Evals

- **Deterministic, every tick:** recipient ∈ cycle; channel per policy; no nudge on absence or outside quiet hours; ≤ max attempts; no write outside the allowlist; idempotence (second tick is a no-op); `verify-loops.mjs` passes.
- **Judged, every packet:** faithfulness (every claim cites a record id), completeness, neutrality (no verdict language), PII hygiene in match explanations; regression vs golden packets blocks the packet.
- **Cost:** tokens per tick and per packet in the ledger — Rippling's AI Spend Console story says per-run economics get scrutinized.

---

## 11. Build plan

| Phase | Days | Output |
|---|---|---|
| 0 | 0.5 | Ports + fixture tenant + `doctor.mjs` + `loop-states.yml` |
| 1 | 1.5 | Engine + lock + ledger + `review-cycle` mode; nightly tick; Slack nudges; calibration packet; `verify-loops.mjs` |
| 2 | 1 | `interview-loop` on the same engine — proves claim 1 |
| 3 | 1 | `req-approval` incl. real `create_draft_hire` path (fixture stub; real call if a tenant appears) |
| 4 | 1 | `rediscovery` + evals + `audit.mjs` |
| 5 | 0.5 | Demo script (8 min) + "what a real tenant unlocks" |

~5.5 days. Phases 0–2 (~3 days) make the one-primitive argument. Parallel track: ask the Rippling team for a test-company token + MCP assignment; fallback App Shop partner program.

---

## 12. Open questions

- Does `job-requisitions-write` support status updates (open → closed)? Else close is a proposal.
- Is the MCP `code` isolate (60s, no network) enough for packet joins? Heavy joins move to REST.
- Slack identity ↔ Rippling worker mapping (email join in fixtures; SCIM-backed on a tenant).
- Custom-object volume for the ledger on a real tenant — periodic export to `tenant/ledger/`.
- Whether Rippling's partner test company includes Recruiting/Performance data at all.

---

## 13. What this gives you in the room

- *"Where does the code live?"* → state in Rippling custom objects under Rippling permissions; the native staged action used where it exists; Tier 3 is the list of objects AI Cloud should expose first.
- *"Why is it safe?"* → the adapter allowlist, the `propose`/`decide` seam, the ledger, the evals — worst bug is a misrouted reminder.
- *"Is it one primitive?"* → three loops on one engine with three mode files; the fourth is the second primitive; five products become views.
- *"Aren't you redefining the ATS?"* → no: real entities are read by ID and never copied; only cycle state is new; two shadow objects are labeled temporary.
- *"Why not Rippling's calendar?"* → that is the internal design; the POC uses Rippling absence as authoritative and Google free/busy only for the one signal not exposed, behind a port that Smart Scheduling replaces.
