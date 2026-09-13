# Per-task provenance and cost

Recovered 2026-09-11 from the `OWNERSHIP.json` markers in the per-task worktrees, before those
worktrees were removed. The commits are also in `PHASE-C.md` and in each task's run record; the
timings are not reded anywhere else, and they are the only measurement of what the review
process actually costs.


| Task         | Exact base | Contract freeze | Accepted  | Freeze → accept |
| ------------ | ---------- | --------------- | --------- | --------------- |
| C2           | `0abcf62`  | `cfeacaa`       | `7139e9c` | 3.2h            |
| C4           | `7139e9c`  | `8442203`       | `4fae147` | 2.2h            |
| C8           | `4fae147`  | `2276ffb`       | `3112038` | 2.8h            |
| B-selfhost-4 | `3112038`  | `7489ad1`       | `84f2f7e` | 0.8h            |
| B-selfhost-3 | `84f2f7e`  | `8fd7318`       | `fd8a99c` | 1.8h            |
| B-selfhost-5 | `fd8a99c`  | `cf39562`       | 4c5bb63   | 1.4h            |
| B-selfhost-6 | 4c5bb63    | `d4d82e5`       | `df49a5e` | 63.7h           |
| B-selfhost-7 | `df49a5e`  | `f759a71`       | `1dc1c5c` | 3.7h            |
| B-selfhost-8 | `1dc1c5c`  | `50a5c65`       | `14beb80` | 27.4h           |


Read these with two corrections. B-selfhost-6's 63.7 hours is mostly idle wall clock — two calendar
days passed with no work on it. B-selfhost-8's 27.4 hours is not: it was continuous, and it is the
cost of the stopping rule that could not terminate. Its productive part ended after round 3, about
three hours in, which is the same range as every other bounded item here.

**The working figure for a bounded item, contract freeze to acceptance, is one to four hours.**
Anything much beyond that is a signal to check the stopping rule rather than to keep going. That is
the estimate to plan the remaining items against, and the reason the revised rule in `PHASE-C.md`
exists.