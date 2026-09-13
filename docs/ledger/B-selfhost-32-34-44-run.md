# B-selfhost-32 + 34 + 44 (+11) run record

**Status:** ACCEPTED. Phase B remains open. Phase C is not accepted.

## Provenance

- Frozen base: `ecfd45d`.
- Frozen contract: revision 5 at `7a91da7`; reviewed body sha256
  `6f87c12b978b7ed861d3f95a6c4ad6edc775c7602551be9a9ac046c5ddba4e13`.
- Accepted implementation: `78a3378`.
- Implementation chain:
  - `c647e79` initial strict-schema and empirical-verifier implementation;
  - `4a198e0` Round-1 fixes;
  - `41a810d` Round-2 fixes;
  - `78a3378` Round-3 fix and final reviewed tree.
- Unmodified-base negative control:
  `git cat-file -e ecfd45d:src/verify/empirical.ts` returned 128 because the contracted production
  module did not exist.

## Delivered

- Reviewer calls use the frozen strict JSON Schema plus
  `reasoning:{effort:"none",exclude:true}`. Legacy `json_object` remains an explicit benchmark
  control only.
- Strict review and score capabilities are actively probed, fail closed, persisted by model ref and
  schema hash, restored after restart, and never inherited from an advertisement.
- Production COMPARING now uses two distinct, explicitly free, probed-strict model families through
  `ModelBroker`; `createVerifierStrategy({backend:"empirical"})` fails loudly without that injection.
- Empirical scoring uses two criteria minimum, four counterbalanced evaluations per criterion,
  bounded integer scores, completed-only reward, sigmoid pair mass and the frozen pivot pair set.
- GATING persists the exact base-to-head `candidate_diff`; COMPARING verifies its label and sends
  its bytes, metrics and gate report as fenced data.
- Limits are 48 empirical attempts and 192,000 estimated input tokens per task across COMPARING
  re-entry. A failed pair abandons the entire empirical selection; deterministic and empirical mass
  are never mixed.
- Sidecar `direct|two_stage` is now `claimedLogprobScheme`; Polish does not claim it observed
  distributions.
- Benchmark supports contemporaneous legacy/strict transports, a separately labelled
  operational-strict configuration, and denominator-preserving comparison output.

## Verification

Node 24.20.0:

- `pnpm typecheck` — pass.
- `pnpm lint` — pass.
- `pnpm deps:check` — pass, 280 modules / 2,062 dependencies.
- `pnpm test` — pass, 83 files / 819 tests.
- `pnpm build` — pass.

Tests include literal frozen schemas, 400/timeout/probe-failed matrices, cached probe epochs,
advertisement stripping, exact provider-wire evidence, four-way family/slot order, completed-only
`5/6` versus `1/6` rewards, N=2/3/4/5/8 pair sets, rate-limit storm capped at 48, persisted
attempt/token ceilings, wrong-base CAS rejection, operational benchmark probe overlays, and
sidecar-claim separation.

## Review history

- Round 1, `c647e79`: Grok and Claude FAIL. Fixed incomplete probe epoch, unobserved re-entry/token
  ceilings, missing operational benchmark, self-referential schema tests, missing 400/strict-route
  controls, and the unobserved CAS loader seam.
- Round 2, `4a198e0`: Grok and Claude FAIL. Fixed advertisement-collinear operational selection,
  fail-open persistence/restore fixtures, and sidecar selection provenance.
- Round 3, `41a810d`: Grok and Claude FAIL. Both found that candidate evidence could be removed from
  the model request while tests stayed green. Added exact provider-wire and production CAS checks;
  also stripped all unprobed strict claims at catalog ingress.
- Round 4, `78a3378`: Grok PASS; Claude PASS.
- Round 5, unchanged `78a3378`: Grok PASS; Claude PASS.

This is two consecutive clean rounds from both required external families on the same commit.

## Live seed-43 benchmark

The exact accepted item-42 corpus and original refs were used:

- `openrouter:nex-agi/nex-n2.5-mini:free`
- `openrouter:nvidia/nemotron-3-super-120b-a12b:free`

The operational probed-strict selector resolves to the same two refs, so the third report is an
independent stochastic replicate/configuration label, not a new model ensemble.

### Original / legacy `json_object`

- Completion: 61/96; schema failures 11; transport failures 24.
- Team primary recall 91.3%; strict recall 65.2%; false positives 81.0%; discrimination 20.0%.
- Tokens: 40,914 input + 87,090 output.
- Packet `58fe8049188c390165c4fbd87968743156086e2811a49fe63b30fc76e2beca9d`.
- Oracle `20b574ea200eed4b121e7112e93017be0c2f50ec7a50b44045786559c4a83fbb`.
- Raw `595c323cff258ac5612ef9a0983f15bb1c9a57955322388ab0f01b6cef01bf91`.
- Rescore `48f094b0e6dcf5c59af848b3df00ce548d2532464ba871be746b1a87f6946c95`.
- Report `b349f9e523f68546a4896fcfeaaa89760fa35a58439f03a5ea547bf9673ab3c7`.

### Original / strict schema

- Completion: 73/96; schema failures 2; transport failures 21.
- Team primary recall 73.9%; strict recall 69.6%; false positives 72.7%; discrimination 9.5%.
- Tokens: 42,159 input + 20,653 output.
- Packet and oracle are byte-identical to the legacy arm.
- Raw `56ae117fa8dd1c4cfeab4808ce58ef48d946a60758dbe712cd79dac02f5e0867`.
- Rescore `bdd8b274dc25e418bc666afd8e245007a287186fb9b834652761e12178df1cf4`.
- Report `1e9c0998b14949e0219ef969cb8cac0da2870378a66fcc70d3fb9b7bebc4dc28`.

### Operational strict

- Completion: 60/96; schema failures 0; transport failures 36.
- Team primary recall 68.4%; strict recall 63.2%; false positives 85.7%; discrimination 5.9%.
- Tokens: 33,915 input + 13,078 output.
- Packet and oracle are byte-identical to the other arms.
- Raw `f05ac1b5cc97762ff02fb3f07008d22f76f25bc186586580037a8e3ffe51ef99`.
- Rescore `c368bb93d44b01ede67ef3e4d746306d73faaf9f4622f0dee58d1b5334b4ba45`.
- Report `b49949123316eff8aaf14e27356018ba1edd40726f4137d42f834b154296ba9d`.

## Decision

Strict transport worked mechanically: schema failures fell from 11 to 2 and then 0; disabling
reasoning cut output tokens from 87,090 to 20,653 in the contemporaneous original-model comparison,
despite more completed cells. It did **not** make raw reviewer findings suitable for production
gating. False positives remained 72.7–85.7%, and pair discrimination fell to 5.9–9.5% on the strict
runs. Quality percentages are conditional on different completion/failure denominators and are not
presented as a strict-versus-legacy quality win.

The accepted scope had no quality threshold and explicitly forbade that claim. The result validates
the next queue position: progress/early-abandonment work (35 + 23) must use measured outcomes, and a
finding-level verifier filter remains justified as a later evidence-driven task rather than being
silently enabled here.
