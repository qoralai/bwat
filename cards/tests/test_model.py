"""The model client's guard (D59): only a reply that finished normally is text.

A cut-off reply can parse as "no cards", so the guard reads the finish reason, never the
text. Usage is recorded first, so a failed call still reports what it spent.
"""

import json

import httpx
import pytest

from writer.model import JevClient, ModelClient, ModelError


def client_replying(finish, seen=None):
    def handle(request):
        if seen is not None:
            seen.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "[]"}, "finish_reason": finish}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 20},
            },
        )

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://models.example.com/v1")
    return ModelClient(http=http, model="test-model", api_key="k-test")


def test_a_normal_reply_is_its_text_sent_as_rules_then_window():
    seen, usage = [], {}
    assert client_replying("stop", seen).complete("the rules", "the window", usage) == "[]"
    assert json.loads(seen[0].content)["messages"] == [
        {"role": "system", "content": "the rules"},
        {"role": "user", "content": "the window"},
    ]
    assert usage == {"in": 1000, "out": 20, "cache_read": None, "cache_write": None, "cost": None, "finish": "stop"}


def test_a_cut_off_reply_is_an_error_and_still_reports_its_usage():
    usage = {}
    with pytest.raises(ModelError):
        client_replying("length").complete("s", "v", usage)
    assert usage["in"] == 1000


def test_a_key_out_of_credit_is_its_own_error_with_no_key_or_body_in_it():
    # QOR-4738: OpenRouter answers 402 when the key has run out of credit.
    def handle(request):
        return httpx.Response(402, json={"error": {"code": 402, "message": "Insufficient credits"}})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://models.example.com/v1")
    with pytest.raises(ModelError) as raised:
        ModelClient(http=http, model="test-model", api_key="k-test").complete("s", "v", {})
    assert str(raised.value) == "model_out_of_credit"


def test_a_broken_card_array_is_not_read_as_its_inner_evidence_list():
    from writer.window import parse_cards

    broken = '[{"bucket": "do", "evidence": [{"epoch": 0, "seq": 8, "quote": "x"}],}]'
    with pytest.raises(ValueError):
        parse_cards(broken)


def test_a_broken_card_array_with_an_empty_evidence_list_is_not_an_empty_window():
    from writer.window import parse_cards

    with pytest.raises(ValueError):
        parse_cards('[{"bucket": "do", "title": "x", "evidence": []}, {"bucket": "do",')


def test_a_call_to_openrouter_routes_only_to_zero_data_retention_endpoints():
    # QOR-4769: OpenRouter's provider.zdr keeps a request off endpoints that retain data.
    seen = []

    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "[]"}, "finish_reason": "stop"}]})

    for base in ("https://openrouter.ai/api/v1", "https://models.example.com/v1"):
        http = httpx.Client(transport=httpx.MockTransport(handle), base_url=base)
        ModelClient(http=http, model="test-model", api_key="k-test").complete("s", "v", {})
    assert seen[0]["provider"] == {"zdr": True}
    assert "provider" not in seen[1]


def jev_answering(respond, seen=None):
    def handle(request):
        if seen is not None:
            seen.append(request)
        return respond(request)

    # The writer's own client, whatever its base: Jev is always OpenRouter's.
    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="http://model.slice.test/v1")
    return JevClient(http, "typesafe/jev-1.13", "k-jev")


def test_jev_scores_a_statement_against_a_state_through_openrouters_decisions_api():
    seen = []
    jev = jev_answering(lambda r: httpx.Response(200, json={"answers": {"due": {"type": "noul", "noul": 0.7}}}), seen)
    assert jev.score({"new_lines": "x"}, "Something new was said.") == 0.7
    request = seen[0]
    assert str(request.url) == "https://openrouter.ai/api/alpha/decisions"
    assert request.headers["authorization"] == "Bearer k-jev"
    assert request.extensions["timeout"]["read"] == 3
    assert json.loads(request.content) == {
        "model": "typesafe/jev-1.13",
        "state": {"new_lines": "x"},
        "questions": {"due": {"type": "noul", "instructions": "Something new was said."}},
    }


@pytest.mark.parametrize("answer", [
    {"answers": {"due": {"noul": 1.5}}},
    {"answers": {"due": {"noul": -0.1}}},
    {"answers": {"due": {"noul": "0.9"}}},
    {"answers": {"due": {"noul": True}}},
    {"answers": {"due": {"noul": None}}},
    {"answers": {"other": {"noul": 0.9}}},
    {"answers": []},
    {},
])
def test_a_jev_answer_that_is_not_a_score_in_zero_to_one_is_an_error(answer):
    with pytest.raises(ModelError):
        jev_answering(lambda r: httpx.Response(200, json=answer)).score({}, "s")


def test_a_jev_answer_of_nan_is_an_error():
    body = b'{"answers": {"due": {"noul": NaN}}}'
    with pytest.raises(ModelError):
        jev_answering(lambda r: httpx.Response(200, content=body)).score({}, "s")


@pytest.mark.parametrize("status", [400, 401, 429, 500])
def test_a_jev_http_error_is_an_error_with_only_its_status(status):
    with pytest.raises(ModelError) as raised:
        jev_answering(lambda r: httpx.Response(status, json={"error": {"message": "k-jev bad"}})).score({}, "s")
    assert str(raised.value) == f"model call failed: HTTPStatusError {status}"


def test_a_jev_timeout_is_an_error():
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ModelError):
        jev_answering(slow).score({}, "s")


# Jev names a card (QOR-4770): a choice question, its options an object of key to text.
CHOICE = {"instructions": "Which card is the same?", "criteria": {"A3": "Ship it", "none": "No card is"}}


def choice_answer(choice="A3", confidence=0.96):
    return {"answers": {"dup_0": {"type": "choice", "choice": choice, "confidence": confidence,
                                  "probabilities": {"A3": 0.96, "none": 0.04}}}}


def test_jev_answers_a_choice_question_with_the_option_it_picked_and_its_confidence():
    seen = []
    jev = jev_answering(lambda r: httpx.Response(200, json=choice_answer()), seen)
    assert jev.decide({"cards": []}, {"dup_0": CHOICE}) == {"dup_0": {"choice": "A3", "confidence": 0.96}}
    assert json.loads(seen[0].content)["questions"] == {"dup_0": {
        "type": "choice", "instructions": "Which card is the same?", "criteria": {"A3": "Ship it", "none": "No card is"}}}


@pytest.mark.parametrize("answer", [
    choice_answer("A9"),
    choice_answer(None),
    choice_answer("A3", 1.5),
    choice_answer("A3", -0.1),
    choice_answer("A3", "0.9"),
    choice_answer("A3", True),
    choice_answer("A3", None),
    {"answers": {"dup_0": {"type": "noul", "noul": 0.9}}},
])
def test_a_choice_answer_off_its_options_or_without_a_confidence_in_zero_to_one_is_an_error(answer):
    with pytest.raises(ModelError):
        jev_answering(lambda r: httpx.Response(200, json=answer)).decide({}, {"dup_0": CHOICE})


def test_a_model_the_endpoint_no_longer_has_is_its_own_error_with_no_key_or_body_in_it():
    # OpenRouter's not_found, 404: "The requested resource (model, file, etc.) does not exist".
    def handle(request):
        return httpx.Response(404, json={"error": {"code": 404, "message": "No endpoints found for test-model."}})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://openrouter.ai/api/v1")
    with pytest.raises(ModelError) as raised:
        ModelClient(http=http, model="test-model", api_key="k-test").complete("s", "v", {})
    assert str(raised.value) == "model_unavailable"


def test_a_model_saved_past_the_zdr_warning_is_called_on_openrouter_without_zdr_routing():
    # The backend serves zdr.writer false for it, and the call carries no provider.
    seen = []

    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "[]"}, "finish_reason": "stop"}]})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://openrouter.ai/api/v1")
    ModelClient(http=http, model="test-model", api_key="k-test", zdr=False).complete("s", "v", {})
    assert "provider" not in seen[0]


# QOR-5079: the card writer's own call (cache_rules), on OpenRouter, to an Anthropic or OpenAI
# model, sends the rules as one block marked for caching, so each window after the first reads
# them from the cache. The window follows the mark and is never cached. Any other host, model
# or caller is sent as before.
CACHED_RULES = [{"type": "text", "text": "the rules", "cache_control": {"type": "ephemeral"}}]


def sent(base, model, zdr=True, usage=None, cache_rules=True):
    seen = []

    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "[]"}, "finish_reason": "stop"}],
                                         "usage": usage or {}})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url=base)
    client = ModelClient(http=http, model=model, api_key="k-test", zdr=zdr, cache_rules=cache_rules)
    client.complete("the rules", "the window", {})
    return seen[0]


@pytest.mark.parametrize("model", ["anthropic/claude-opus-5.5", "openai/gpt-6-astra"])
def test_on_openrouter_an_anthropic_or_openai_model_gets_the_rules_marked_for_caching(model):
    request = sent("https://openrouter.ai/api/v1", model)
    assert request["messages"] == [
        {"role": "system", "content": CACHED_RULES},
        {"role": "user", "content": "the window"},
    ]
    assert request["provider"] == {"zdr": True}


def test_a_model_saved_past_the_zdr_warning_still_gets_the_rules_marked_for_caching():
    request = sent("https://openrouter.ai/api/v1", "anthropic/claude-opus-5.5", zdr=False)
    assert request["messages"][0]["content"] == CACHED_RULES
    assert "provider" not in request


def test_a_caller_that_does_not_ask_for_it_gets_the_rules_as_before():
    # Reconciliation and the agenda summary share the client; their prompts are not the writer's rules.
    request = sent("https://openrouter.ai/api/v1", "anthropic/claude-opus-5.5", cache_rules=False)
    assert request["messages"][0] == {"role": "system", "content": "the rules"}


@pytest.mark.parametrize("model", ["google/gemini-3-pro", "deepseek/deepseek-v4", "test-model"])
def test_on_openrouter_any_other_model_gets_the_rules_as_before(model):
    assert sent("https://openrouter.ai/api/v1", model)["messages"][0] == {"role": "system", "content": "the rules"}


@pytest.mark.parametrize("base", ["https://models.example.com/v1", "https://api.openai.com/v1"])
def test_another_host_gets_the_rules_as_before_whatever_the_model(base):
    for model in ("anthropic/claude-opus-5.5", "openai/gpt-6-astra"):
        request = sent(base, model)
        assert request["messages"][0] == {"role": "system", "content": "the rules"}
        assert "provider" not in request


def test_usage_records_what_the_cache_read_and_wrote_and_what_the_call_cost():
    usage = {}

    def handle(request):
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "[]"}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 15000, "completion_tokens": 900, "cost": 0.0321,
                      "prompt_tokens_details": {"cached_tokens": 11500, "cache_write_tokens": 0}}})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://openrouter.ai/api/v1")
    # A cut-off reply still reports what it spent.
    with pytest.raises(ModelError):
        ModelClient(http=http, model="anthropic/claude-opus-5.5", api_key="k-test", cache_rules=True).complete("s", "v", usage)
    assert usage == {"in": 15000, "out": 900, "cache_read": 11500, "cache_write": 0, "cost": 0.0321, "finish": "length"}


def test_usage_without_cache_details_records_none_for_them():
    # OpenRouter documents prompt_tokens_details as an object or null.
    usage = {}

    def handle(request):
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "[]"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 15000, "completion_tokens": 900, "prompt_tokens_details": None}})

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://openrouter.ai/api/v1")
    ModelClient(http=http, model="anthropic/claude-opus-5.5", api_key="k-test", cache_rules=True).complete("s", "v", usage)
    assert usage == {"in": 15000, "out": 900, "cache_read": None, "cache_write": None, "cost": None, "finish": "stop"}


def test_the_rules_are_the_same_text_for_every_window_meeting_and_board():
    from writer.window import build_parts

    def frame(seq, speaker, text):
        return {"epoch": 0, "seq": seq, "speaker": {"label": speaker, "member_id": None}, "text": text,
                "start_ms": seq * 1000, "end_ms": seq * 1000 + 900, "source": "asr"}

    board = {"A7": {"display_id": "A7", "kind": "todo", "title": "Ship the Quarzite build", "version": 3,
                    "retired": False, "draft": True, "detail": "Zebulon owns it"}}
    first, _ = build_parts([frame(1, "Ada Lovelace", "hello")], {})
    again, window = build_parts([frame(9, "Zebulon Quark", "Quarzite ships Friday")], board,
                                [frame(8, "Ada Lovelace", "earlier")])
    assert first == again
    assert "Zebulon" in window and "Zebulon" not in again and "Quarzite" not in again
    assert build_parts([], {}, granularity="fewer")[0] != first
