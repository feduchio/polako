# llm-verifier sidecar

Persistent JSON-lines stdio process used by TypeScript `VerifierAdapter`.
Python is not the orchestrator runtime. Scoring goes through PyPI
`llm-verifier` 0.2.0 (`llm_verifier.select` / `compare`).

## Environment

From the repository root:

```bash
python3 -m venv sidecars/llm_verifier/.venv
sidecars/llm_verifier/.venv/bin/python -m pip install -r sidecars/llm_verifier/requirements.txt
```

The adapter prefers `.venv/bin/python` when that path exists, otherwise `python3`.
If the interpreter or `llm-verifier` package is missing, health fails and the
orchestrator falls back to the TypeScript pairwise judge.

## Clients

Default production/test scoring uses an injected client (`POLISH_VERIFIER_CLIENT=scripted`)
or no client at all. A missing client is a protocol error, not a live Vertex /
OpenRouter / Gemini call. Live backends are opt-in via `POLISH_VERIFIER_ALLOW_LIVE=1`
and are not used for C3 acceptance.

Two-stage logprobs: if the configured verifier withholds token-level logprobs, the
sidecar asks a closed model for reasoning + draft scores, then an open verifier
for `<score_A>` / `<score_B>` logprobs. Logprob-capable verifiers skip that workaround.

## Protocol

One JSON object per stdin line; one JSON object per stdout line. Requests carry a
numeric `id`. Operations: `health`, `compare` / `score_pair`, `select`.
