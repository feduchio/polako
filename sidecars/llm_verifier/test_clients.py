"""Sidecar client unit tests. Invoked from Vitest; no live API calls."""

from __future__ import annotations

import unittest

from clients import ScriptedOpenAIClient, TwoStageClient, _has_logprobs


PROMPT = """You are an expert evaluator of AI coding agents.
**Trajectory A:**
{"id": "alpha", "metrics": {"checksPassed": 0, "newFailures": 9, "linesChanged": 999}}
**Trajectory B:**
{"id": "beta", "metrics": {"checksPassed": 9, "newFailures": 0, "linesChanged": 1}}
**Rating Scale:**
letters
"""


class ScriptedClientTests(unittest.TestCase):
    def test_prefers_injected_id_not_heuristic_metrics(self) -> None:
        client = ScriptedOpenAIClient(mode="direct", preferred="alpha")
        response = client.chat.completions.create(
            model="scripted-verifier",
            messages=[{"role": "user", "content": PROMPT}],
            logprobs=True,
        )
        text = response.choices[0].message.content
        self.assertIn("<score_A> A </score_A>", text)
        self.assertIn("<score_B> T </score_B>", text)
        self.assertTrue(_has_logprobs(response))

    def test_two_stage_when_logprobs_withheld(self) -> None:
        closed = ScriptedOpenAIClient(mode="withheld", preferred="alpha")
        wrapper = TwoStageClient(closed)
        response = wrapper.create(
            model="scripted-verifier",
            messages=[{"role": "user", "content": PROMPT}],
            logprobs=True,
        )
        self.assertEqual(wrapper.last_scheme, "two_stage")
        self.assertTrue(_has_logprobs(response))
        self.assertIn("withheld token-level logprobs", closed.prompts[-1])

    def test_direct_logprob_skips_two_stage(self) -> None:
        closed = ScriptedOpenAIClient(mode="direct", preferred="beta")
        wrapper = TwoStageClient(closed)
        response = wrapper.create(
            model="scripted-verifier",
            messages=[{"role": "user", "content": PROMPT}],
            logprobs=True,
        )
        self.assertEqual(wrapper.last_scheme, "direct")
        self.assertTrue(_has_logprobs(response))
        self.assertEqual(len(closed.prompts), 1)


if __name__ == "__main__":
    unittest.main()
