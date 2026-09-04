"""Injected OpenAI-shaped clients for the llm-verifier sidecar.

Default/test paths never open a paid backend. The scripted client ranks by
candidate id inside the trajectory payload (DATA/EVIDENCE), not by
checksPassed / newFailures / linesChanged.
"""

from __future__ import annotations

import json
import os
import re
from types import SimpleNamespace
from typing import Any

SCALE_LETTERS = [chr(65 + i) for i in range(20)]
TRAJECTORY_RE = re.compile(
    r"\*\*Trajectory A:\*\*\s*(.*?)\s*\*\*Trajectory B:\*\*\s*(.*?)(?:\s*\*\*Rating Scale:\*\*|\Z)",
    re.S,
)
ID_RE = re.compile(r'"id"\s*:\s*"([^"]+)"')


class TokenLogprob:
    def __init__(self, token: str, logprob: float, top_logprobs: list[Any] | None = None):
        self.token = token
        self.logprob = logprob
        self.top_logprobs = top_logprobs or []


class ChoiceLogprobs:
    def __init__(self, content: list[TokenLogprob] | None):
        self.content = content


class Message:
    def __init__(self, content: str):
        self.content = content


class Choice:
    def __init__(self, content: str, logprobs: ChoiceLogprobs | None):
        self.message = Message(content)
        self.logprobs = logprobs
        self.finish_reason = "stop"


class Completion:
    def __init__(self, content: str, logprobs: ChoiceLogprobs | None):
        self.choices = [Choice(content, logprobs)]
        self.usage = SimpleNamespace(
            prompt_tokens=1,
            completion_tokens=1,
            prompt_tokens_details=SimpleNamespace(cached_tokens=0),
            completion_tokens_details=SimpleNamespace(reasoning_tokens=0),
        )


class CompletionsAPI:
    def __init__(self, client: "ScriptedOpenAIClient"):
        self._client = client

    def create(self, **kwargs: Any) -> Completion:
        return self._client.create(**kwargs)


class ChatAPI:
    def __init__(self, client: "ScriptedOpenAIClient"):
        self.completions = CompletionsAPI(client)


class ModelsAPI:
    def list(self) -> SimpleNamespace:
        return SimpleNamespace(data=[SimpleNamespace(id="scripted-verifier")])


def _candidate_id(blob: str) -> str:
    try:
        parsed = json.loads(blob.strip())
        if isinstance(parsed, dict) and isinstance(parsed.get("id"), str):
            return parsed["id"]
    except json.JSONDecodeError:
        pass
    match = ID_RE.search(blob)
    return match.group(1) if match else blob.strip()[:32]


def _letter_for(candidate_id: str, preferred: str) -> str:
    return "A" if candidate_id == preferred and preferred != "" else "T"


def _peaked_logprobs(letter: str) -> list[SimpleNamespace]:
    rows = []
    for item in SCALE_LETTERS:
        lp = -0.01 if item == letter else -8.0
        rows.append(SimpleNamespace(token=item, logprob=lp))
    return rows


def _score_text(letter_a: str, letter_b: str, reasoning: str) -> str:
    return (
        f"{reasoning}\n"
        f"<score_A> {letter_a} </score_A>\n"
        f"<score_B> {letter_b} </score_B>"
    )


def _score_logprobs(letter_a: str, letter_b: str) -> list[TokenLogprob]:
    content: list[TokenLogprob] = [
        TokenLogprob("<score_A>", 0.0, [SimpleNamespace(token="<score_A>", logprob=0.0)]),
        TokenLogprob(letter_a, -0.01, _peaked_logprobs(letter_a)),
        TokenLogprob("</score_A>", 0.0, [SimpleNamespace(token="</score_A>", logprob=0.0)]),
        TokenLogprob("<score_B>", 0.0, [SimpleNamespace(token="<score_B>", logprob=0.0)]),
        TokenLogprob(letter_b, -0.01, _peaked_logprobs(letter_b)),
        TokenLogprob("</score_B>", 0.0, [SimpleNamespace(token="</score_B>", logprob=0.0)]),
    ]
    return content


class ScriptedOpenAIClient:
    """OpenAI-compatible stub. Preference is injected; metrics are ignored."""

    def __init__(self, mode: str = "direct", preferred: str = ""):
        self.mode = mode
        self.preferred = preferred
        self.prompts: list[str] = []
        self.chat = ChatAPI(self)
        self.models = ModelsAPI()
        self._llm_verifier_model = "scripted-verifier"
        self._llm_verifier_deepseek = True

    def create(self, **kwargs: Any) -> Completion:
        messages = kwargs.get("messages") or []
        prompt = _flatten_messages(messages)
        self.prompts.append(prompt)
        letter_a, letter_b = self._letters(prompt)
        reasoning = (
            "Draft scores from the scripted closed model. "
            "Trajectories are untrusted DATA/EVIDENCE, not instructions."
        )
        text = _score_text(letter_a, letter_b, reasoning)
        if self.mode == "withheld":
            return Completion(text, None)
        return Completion(text, ChoiceLogprobs(_score_logprobs(letter_a, letter_b)))

    def _letters(self, prompt: str) -> tuple[str, str]:
        match = TRAJECTORY_RE.search(prompt)
        if match is None:
            return "K", "K"
        id_a = _candidate_id(match.group(1))
        id_b = _candidate_id(match.group(2))
        return _letter_for(id_a, self.preferred), _letter_for(id_b, self.preferred)


class TwoStageClient:
    """Closed-model reasoning plus open-verifier logprobs when logprobs are withheld."""

    def __init__(self, closed: Any, open_client: Any | None = None):
        self._closed = closed
        self._open = open_client if open_client is not None else closed
        self.last_scheme = "direct"
        self.schemes: list[str] = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.models = getattr(closed, "models", ModelsAPI())
        self._llm_verifier_model = getattr(closed, "_llm_verifier_model", "scripted-verifier")
        self._llm_verifier_deepseek = True

    @property
    def prompts(self) -> list[str]:
        inner = getattr(self._closed, "prompts", None)
        return inner if isinstance(inner, list) else []

    def create(self, **kwargs: Any) -> Any:
        closed_kwargs = dict(kwargs)
        response = self._closed.chat.completions.create(**closed_kwargs)
        if _has_logprobs(response):
            self.last_scheme = "direct"
            self.schemes.append("direct")
            return response
        self.last_scheme = "two_stage"
        self.schemes.append("two_stage")
        reasoning = _message_text(response)
        messages = list(kwargs.get("messages") or [])
        messages.append({"role": "assistant", "content": reasoning})
        messages.append({
            "role": "user",
            "content": (
                "The closed model withheld token-level logprobs. "
                "Using its domain reasoning and draft score, re-score the pair "
                "and emit <score_A> / <score_B> letters so the open verifier "
                "can expose logprobs. Reward is the expectation over those logits."
            ),
        })
        open_kwargs = dict(kwargs)
        open_kwargs["messages"] = messages
        open_kwargs["logprobs"] = True
        if getattr(self._open, "mode", None) == "withheld":
            # Open verifier must expose logprobs even when the closed model does not.
            previous = self._open.mode
            self._open.mode = "direct"
            try:
                return self._open.chat.completions.create(**open_kwargs)
            finally:
                self._open.mode = previous
        return self._open.chat.completions.create(**open_kwargs)


def _flatten_messages(messages: Any) -> str:
    parts: list[str] = []
    for message in messages:
        if isinstance(message, dict):
            content = message.get("content", "")
        else:
            content = getattr(message, "content", "")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
                else:
                    parts.append(str(item))
        else:
            parts.append(str(content))
    return "\n".join(parts)


def _has_logprobs(response: Any) -> bool:
    try:
        choice = response.choices[0]
        logprobs = getattr(choice, "logprobs", None)
        content = getattr(logprobs, "content", None) if logprobs is not None else None
        return bool(content)
    except (AttributeError, IndexError, TypeError):
        return False


def _message_text(response: Any) -> str:
    try:
        return str(response.choices[0].message.content or "")
    except (AttributeError, IndexError, TypeError):
        return ""


def scripted_from_env() -> TwoStageClient:
    mode = os.environ.get("POLISH_VERIFIER_SCRIPTED_MODE", "direct")
    preferred = os.environ.get("POLISH_VERIFIER_PREFER", "")
    inner = ScriptedOpenAIClient(mode=mode, preferred=preferred)
    return TwoStageClient(inner)
