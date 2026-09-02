---
name: talent-loops
description: Run a Talent Loops cycle (review-cycle, interview-loop, req-approval, rediscovery) by loading the layered mode context and calling only the bin/ scripts.
---

# talent-loops — router

Resolve the loop, check the checkout, load the context, run the mode. Nothing else belongs in
this file: the instructions live in `modes/`, and every write lives in `bin/`.

## 1. Resolve the loop

The argument names the loop.

| Argument         | Mode file                 | Status    |
| ---------------- | ------------------------- | --------- |
| `review-cycle`   | `modes/review-cycle.md`   | available |
| `interview-loop` | `modes/interview-loop.md` | M2        |
| `req-approval`   | `modes/req-approval.md`   | M3        |
| `rediscovery`    | `modes/rediscovery.md`    | M4        |

No argument, an unknown argument, or a mode file that does not exist yet: say so and stop.
Never guess the loop, and never substitute a different one.

## 2. Check the checkout

Run `node bin/doctor.mjs --json` before anything else, every time.

- Exit code `0` → continue.
- Non-zero → print each failing check with its `fix` line, then stop. Do not work around a
  failing check, and do not edit anything to make it pass.

## 3. Load the context, in this order

1. `modes/_shared.md` — engine contract, safety rules, untrusted content, output format.
2. `modes/_tenant.md` — this tenant's policy, in prose over `tenant/policy.yml`.
3. `modes/_custom.md` — house rules. Later layers win on conflict, but no layer can relax a
   safety rule from `_shared.md`.
4. `modes/<loop>.md` — the loop itself.

Read all four before taking the first action.

## 4. Run the mode

Follow the mode's steps in order and report in the format `_shared.md` specifies.

Three rules hold for the whole run, whatever the mode says: the `bin/*` scripts are the only
writers; decisions of record happen only through `bin/propose.mjs` and `bin/decide.mjs`; you
never edit files under `data/`, `fixtures/` or `tenant/`.
