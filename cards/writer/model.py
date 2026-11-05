"""The card writer's model call, through an OpenAI-compatible chat completions API (D59).

Only a reply that finished normally is text: a cut-off reply can still parse as "no cards",
and reading it as an empty window would silently skip that stretch of the meeting. Usage
is recorded first, so a failed call still reports what it spent.

A call to OpenRouter carries provider.zdr, so it is routed only to endpoints on its
zero-data-retention list (QOR-4769), unless the backend says the model has none and an
admin saved it past that warning (zdr.writer false). There the card writer's own call
(cache_rules) to an Anthropic or OpenAI model sends the rules as one block marked for caching
(QOR-5079; what each model caches, and for how long: cards/README.md). Jev, OpenRouter's
Decisions API, answers whether the writer is due (JevClient); it shares the writer's client and its errors.
"""

import math
import time

import httpx

# OpenRouter answers 402 Payment Required when "your account or API key has insufficient
# credits", with a body of {"error": {"code": 402, "message": ...}}
# (https://openrouter.ai/docs/api-reference/errors). The board shows this code (QOR-4738).
OUT_OF_CREDIT = "model_out_of_credit"
# OpenRouter's not_found, 404: "The requested resource (model, file, etc.) does not exist".
# The model is gone for good, not down: the writer pauses until the settings change.
MODEL_UNAVAILABLE = "model_unavailable"
OPENROUTER = "openrouter.ai"
DECISIONS_URL = f"https://{OPENROUTER}/api/alpha/decisions"
# The models the writer marks its rules for (https://openrouter.ai/docs/features/prompt-caching):
# an Anthropic model caches only up to a mark; an OpenAI model caches a long prefix on its own,
# and on GPT-5.6 and later OpenRouter turns the mark into OpenAI's explicit breakpoint.
CACHED = ("anthropic/", "openai/")
# A Jev answer that takes longer, in any phase or in all, is a failure: the writer falls
# back to its cadence (QOR-4769).
JEV_TIMEOUT_S = 3


class ModelError(Exception):
    """The model gave no usable reply; the window is not read."""


def failure(err):
    """The ModelError for a failed call: the status, never the body or headers, so the key
    cannot reach a log."""
    status = err.response.status_code if isinstance(err, httpx.HTTPStatusError) else ""
    if status == 402:
        return ModelError(OUT_OF_CREDIT)
    if status == 404:
        return ModelError(MODEL_UNAVAILABLE)
    return ModelError(f"model call failed: {type(err).__name__} {status}".rstrip())


class ModelClient:
    def __init__(self, http: httpx.Client, model: str, api_key: str, max_tokens: int = 64000, zdr: bool = True,
                 cache_rules: bool = False):
        self._http = http
        self._model = model
        self._api_key = api_key
        self._max_tokens = max_tokens
        self._zdr = zdr
        self._cache_rules = cache_rules

    def complete(self, stable: str, volatile: str, usage: dict) -> str:
        """The reply text for the rules (`stable`) and the window (`volatile`)."""
        openrouter = self._http.base_url.host == OPENROUTER
        if self._cache_rules and openrouter and self._model.startswith(CACHED):
            stable = [{"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}}]
        try:
            request = {
                "model": self._model,
                "max_tokens": self._max_tokens,
                "messages": [
                    {"role": "system", "content": stable},
                    {"role": "user", "content": volatile},
                ],
            }
            if self._zdr and openrouter:
                request["provider"] = {"zdr": True}
            response = self._http.post(
                "chat/completions",
                # No key, no header: a model on a trusted host takes none, and an empty
                # "Bearer " is not a valid header value.
                headers={"Authorization": f"Bearer {self._api_key}"} if self._api_key else {},
                json=request,
            )
            response.raise_for_status()
            body = response.json()
            choice = body["choices"][0]
        except (httpx.HTTPError, ValueError, KeyError, IndexError) as err:
            raise failure(err) from err
        tokens = body.get("usage") or {}
        cache = tokens.get("prompt_tokens_details") or {}
        usage.update(
            {"in": tokens.get("prompt_tokens"), "out": tokens.get("completion_tokens"),
             "cache_read": cache.get("cached_tokens"), "cache_write": cache.get("cache_write_tokens"),
             "cost": tokens.get("cost"), "finish": choice.get("finish_reason")}
        )
        if usage["finish"] != "stop":
            raise ModelError(f"model stopped early ({usage['finish']}); a cut-off reply is not an empty window")
        content = (choice.get("message") or {}).get("content")
        if not (content and isinstance(content, str)):
            raise ModelError("model reply has no text")
        return content


def model_http(settings, transport, timeout=300):
    """The HTTP client for the card writer's model host, for the caller to close."""
    return httpx.Client(base_url=settings.base_url, transport=transport, timeout=timeout)


def writer_model(http, settings, **options):
    """The card writer's model with these settings. No key, no header: a model on a trusted
    host takes none."""
    return ModelClient(http, settings.model, settings.api_key or "", zdr=settings.zdr, **options)


class JevClient:
    """Jev's score, 0 to 1, that a statement is true of a state (QOR-4769). Any failure, a
    400 included, is a ModelError, and so is an answer slower than JEV_TIMEOUT_S in all.
    `clock`: tests only."""

    def __init__(self, http: httpx.Client, model: str, api_key: str, clock=time.monotonic):
        self._http = http
        self._model = model
        self._api_key = api_key
        self._clock = clock

    def score(self, state, statement: str) -> float:
        return self.decide(state, {"due": statement})["due"]

    def decide(self, state, questions: dict, timeout: float = JEV_TIMEOUT_S) -> dict:
        """Each of `questions` answered in one call; slower than `timeout` in all fails. A
        statement ({key: text}) is a noul question, answered with its score. One with options
        ({key: {"instructions": text, "criteria": {option: text}}}) is a choice question,
        answered with {"choice": option, "confidence": 0 to 1}: Jev names the card a
        duplicate hint is about (QOR-4770)."""
        start = self._clock()
        try:
            response = self._http.post(
                DECISIONS_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"model": self._model, "state": state,
                      "questions": {key: {"type": "noul", "instructions": q} if isinstance(q, str)
                                    else {"type": "choice", "instructions": q["instructions"], "criteria": q["criteria"]}
                                    for key, q in questions.items()}},
                timeout=timeout,
            )
            response.raise_for_status()
            answers = response.json()["answers"]
            found = {key: answers[key]["noul"] if isinstance(q, str)
                     else {"choice": answers[key]["choice"], "confidence": answers[key]["confidence"]}
                     for key, q in questions.items()}
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as err:
            raise failure(err) from err
        # httpx's timeout is per phase; the total is checked here (QOR-4769).
        if self._clock() - start > timeout:
            raise ModelError("jev answer too slow")
        if any(not unit(found[key] if isinstance(q, str) else found[key]["confidence"]) for key, q in questions.items()):
            raise ModelError("jev answer is not a score")
        if any(not isinstance(q, str) and found[key]["choice"] not in q["criteria"] for key, q in questions.items()):
            raise ModelError("jev answer is not one of the options")
        return found


def unit(score):
    """A score or a confidence: a finite number from 0 to 1."""
    return type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 1
