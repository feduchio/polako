# `docs/RECOVERY.md` §3 — where each item ended

One pass, 2026-09-15, from HOST `e87dd26`. Every item was implemented, gated, and reviewed by one
GPT lane (`gpt-5.6-sol-high`) per the user's instruction of that date; fix rounds are unbounded by
that instruction, and the plan's own ceiling of three rounds and 300 lines is what stopped four of
them. Gate at close: Node 24.20.0, `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest
run --maxWorkers=2` → exit 0, 96 files, 1,163 tests (1,077 at `e87dd26`).

| Item | Outcome | Rounds | Record |
|---|---|---|---|
| **R0** cost ceiling + budget | config applied; acceptance 1 passed, **acceptance 2 open** pending R3's live re-check; reformulated at the ceiling | 3 | `R0-run.md` |
| **R0a** admission is a reservation | closed at the ceiling; `maxRunUsd` is a bound under concurrency | 4 | `R0a-run.md` |
| **R1** account-scoped 429 | stopped at the ceiling; four sites fixed, the word "account" found wrong | 2 | `R1-run.md` |
| **R2** reviewer canary | stopped at the ceiling; `DONE` now requires a reviewer that found a planted defect | 2 | `R2-run.md` |
| **R3** a run that stops says why | stopped at the ceiling; verified live in R5 | 3 | `R3-run.md` |
| **R4** decompose once | claimed, leased, re-checked; **the only item under 300 lines** | 1 | `R4.md` |
| **R5** first paid run | **not accepted** — the run never reached `REVIEWING`; criterion unevaluable | — | `R5-run.md` |
| **R6** re-measure the economics | done; the suspended programme stays suspended | — | `R6-run.md` |

## What the plan was for, and whether it got there

§1.1 — *the reviewing core never worked and nobody noticed*. **Addressed.** A clean round now
requires every model that produced it to have found a seeded defect, and `DONE` is refused
otherwise, at the place the verdict is granted rather than where the round is recorded (R2). Not
yet demonstrated on a live review, because R5 did not reach one.

§1.2 — *the transport, not the models*. **Confirmed gone, on real evidence.** R5 made 148 worker
calls with zero failures; the earlier reading was 2,465 of 2,600 executions that never reached a
model. Two causes were removed: the free tier's cap stopped being the only lane (R0), and an
account-wide limit stopped being recorded as a fact about whichever model asked (R1).

§1.3 — *the economic programme aimed at an artefact*. **Settled, against the programme.** The
reviewer is 26.4% of tokens and **0%** of dollars; the worker is 65.6% and 96.4% (R6). Every item
`docs/PLAN.md` suspended pending this measurement reduces the cost of reviewing.

§1.4 — *runs aimed at `/tmp` instead of real code*. **Held.** Every run in this pass targeted
`~/screen-audit-toolkit`. Five runs, $0.107 total.

§1.5 — *the cost of the process*. **Not held.** Four of eight items breached the 300-line ceiling,
one of them by 429 lines. Each breach is recorded where it happened rather than argued with. The
ceiling counts tests, and this codebase's own verification practice — one single-input case per
boundary, after P1.9 — makes that count unbounded; whether the rule should say so is the plan
author's to decide, not an item's.

## Open, with contracts written

| Item | Subject | From |
|---|---|---|
| **R1a** | the rpm window exists and is switched off | plan §3 R1 clause 1 |
| **R1b** | 76 probe observations replay into routing statistics | R0 round 2, R1 |
| **R1c** | a free-tier allowance is not the whole account; and it should not cost task attempts | R1 round 2 |
| **R7** | a worker that cannot finish must stop, not spend | **R5, observed** |

R7 is the one that matters next: it is 96.4% of the money, it was observed rather than reasoned
about, and R5 cannot be re-run to its criterion until it is fixed.

## Three things this pass got wrong, kept where they happened

1. **R0 declared itself "0 lines of code"** on the plan's word. The first live run falsified that in
   45 seconds, for $0.0038, and the item ended with five code defects repaired.
2. **A size figure measured before `git add`** counted 278 lines where the commit held 448. A
   measurement of an unstaged tree is not a measurement of a commit.
3. **A ruling that R0 had not created any of the 76 probe observations** was false; it had created
   36, in the two runs it used as its own evidence. Checking `git log` before ruling would have cost
   one command.
