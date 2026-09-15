# R1b — A replayed observation is still an observation

**Origin:** `docs/ledger/R0-run.md` review round 2 finding 1, and its round-3 correction.
**Status:** contracted, not implemented. **Reviewer lane:** GPT, one lane.

## Defect (normative)

R0 stopped the broker recording probe calls as routing statistics, and R1 stopped it recording
account-scoped rate limits. Neither touches the replay: `ModelObservationRepository.restoreCatalog`
rebuilds `model_observations` from the event log and feeds every `call` observation into
`ModelCatalog.recordCall` on daemon start. Observations written before those rules existed are
replayed as if they had never been ruled out.

The residue is measured, not estimated:

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select json from events where type='model.call'
    and json_extract(json,'$.payload.role')='probe';" | node -e '…sum attemptOutcomes…'
76 attempts, 67 failures: 51 rate_limit, 16 bad_request, across 11 models
```

One observation was recorded per attempt. **36 of the 76 were written by R0 itself**, in the two
runs it used as evidence, between brokering the tools and json probes and suppressing them.

## Required end state

1. A `call` observation records the role of the call that produced it, so the replay can apply the
   same rule the recording does.
2. `restoreCatalog` skips observations the recording rule would have skipped.
3. The observations already written, which carry no role, are handled by a stated rule rather than
   by silence. The rule must be written down with its consequence: whatever is chosen, the record
   says how many observations it affects and what a model's failure ratio becomes under it.

## Acceptance checks

1. A probe observation written after this item is not replayed into `catalog.recordCall`.
2. A worker observation is.
3. Whatever rule is chosen for the 76 legacy rows, a test fixes it in place: given that event log,
   the catalogue statistics after `restoreCatalog` are the stated ones.
4. Gate green at Node 24.

## Non-goal

Rewriting history. The event log is append-only; this item decides how it is *read*.
