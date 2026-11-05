"""D139 / QOR-4557: meeting audio never goes where it could train a model.

Zoom's API terms forbid letting AI train on meeting content. Through OpenRouter no
per-request flag reaches the provider, so the guard is OpenRouter's published Zero Data
Retention list: audio goes to an OpenRouter model only while every endpoint serving it is
on that list. OpenAI's own API does not train on API data. Any other host is refused unless
the operator names it in BWAT_ASR_TRUSTED_HOSTS. Cleartext is refused unless trusted.

Ported from the prototype's no-training tests (docs/provenance.md), against the fake
OpenRouter, asserting on what would leave the process.
"""
import json
import logging
import pathlib

import pytest

from bwat_bot import transcription
from bwat_bot.config import Config, ConfigError
from tests.conftest import Clock
from tests.fake_asr import (
    DEEPGRAM_URL,
    MODEL,
    NOVA,
    OPENAI_URL,
    OPENROUTER_URL,
    PCM,
    FakeOpenRouter,
    config_for,
    make,
)


@pytest.fixture(autouse=True)
def _events(caplog):
    caplog.set_level(logging.INFO, logger="bwat_bot")


def events(caplog, name: str, field: str) -> list[str]:
    """The `field` of each `name` event logged, in order."""
    return [getattr(r, field) for r in caplog.records if r.getMessage() == name]


def refusals(caplog) -> list[str]:
    return events(caplog, "transcription.refused", "reason")


async def test_audio_is_sent_when_every_endpoint_is_zero_data_retention():
    fake = FakeOpenRouter()
    t = make(fake)
    assert await t.transcribe(PCM) == "hello"
    (post,) = fake.audio_posts()
    assert str(post.url) == OPENROUTER_URL
    assert post.headers["authorization"] == "Bearer sk-or-test"
    body = post.content
    assert b'name="model"' in body and MODEL.encode() in body
    assert b'filename="speech.wav"' in body and b"RIFF" in body


async def test_audio_is_withheld_when_the_model_is_not_zero_data_retention(caplog):
    fake = FakeOpenRouter(zdr=("Some Other | model",))
    t = make(fake)
    assert await t.transcribe(PCM) == ""
    assert await t.ready() is False
    assert fake.audio_posts() == []
    assert refusals(caplog) == ["not_zdr"]


async def test_one_non_zdr_endpoint_withholds_audio():
    # Routing preferences are not applied on /audio/transcriptions, so a model with a
    # second, non-ZDR endpoint could be served by it.
    fake = FakeOpenRouter(served=(NOVA, "Reseller | deepgram/nova-3"))
    assert await make(fake).transcribe(PCM) == ""
    assert fake.audio_posts() == []


async def test_a_model_with_no_listed_endpoints_withholds_audio():
    fake = FakeOpenRouter(served=())
    assert await make(fake).transcribe(PCM) == ""
    assert fake.audio_posts() == []


@pytest.mark.parametrize("body", [
    {"data": {"endpoints": "not a list"}},
    {"data": {"endpoints": [{"no_name": 1}]}},
    {"data": None},
    ["not", "an", "object"],
])
async def test_a_policy_answer_of_the_wrong_shape_withholds_audio(body, caplog):
    fake = FakeOpenRouter()
    fake.policy = (body, {"data": [{"name": NOVA}]})
    assert await make(fake).transcribe(PCM) == ""
    assert fake.audio_posts() == []
    assert refusals(caplog) == ["lookup_failed"]


async def test_a_failed_lookup_is_held_then_checked_again(caplog):
    fake = FakeOpenRouter(zdr_status=503)
    clock = Clock()
    t = make(fake, clock=clock)
    for _ in range(5):
        assert await t.transcribe(PCM) == ""
    assert fake.policy_gets() == 2  # one lookup (two routes) for the whole hold
    assert refusals(caplog) == ["lookup_failed"]  # reported once, not per segment
    fake.zdr_status = 200  # OpenRouter recovers; once the hold expires...
    clock.now += transcription.FAIL_HOLD_SECONDS + 1
    assert await t.transcribe(PCM) == "hello"  # ...the next segment checks again
    assert len(fake.audio_posts()) == 1
    assert "transcription.open" in [r.getMessage() for r in caplog.records]


async def test_a_passing_check_is_cached_then_rechecked():
    fake = FakeOpenRouter()
    clock = Clock()
    t = make(fake, clock=clock)
    await t.transcribe(PCM)
    await t.transcribe(PCM)
    assert fake.policy_gets() == 2  # one check for both segments
    fake.zdr = []  # the provider's policy changes...
    clock.now += transcription.RECHECK_SECONDS + 1  # ...and the cache expires
    assert await t.transcribe(PCM) == ""
    assert len(fake.audio_posts()) == 2


async def test_the_real_openrouter_response_shapes_pass_for_nova_3():
    # Responses captured from the live API on 2026-10-01 (the ZDR list trimmed), so the
    # guard is tested against OpenRouter's real schema, not only the fake's.
    captured = json.loads((pathlib.Path(__file__).parent / "fixtures"
                           / "openrouter_zdr_2026-10-01.json").read_text(encoding="utf-8"))
    fake = FakeOpenRouter()
    fake.policy = (captured["endpoints"], captured["zdr"])
    assert await make(fake).transcribe(PCM) == "hello"
    assert len(fake.audio_posts()) == 1


async def test_openai_is_sent_untouched_with_the_openai_key():
    fake = FakeOpenRouter()
    t = make(fake, OPENAI_URL)
    assert await t.transcribe(PCM) == "hello"
    assert [str(r.url) for r in fake.requests] == [OPENAI_URL]  # no policy lookup
    assert fake.requests[0].headers["authorization"] == "Bearer sk-oa-test"


async def test_an_unknown_host_is_refused_and_reported_once(caplog):
    # A proxy or alias in front of OpenRouter, or any other provider, has not been shown
    # to keep audio out of training: fail closed.
    fake = FakeOpenRouter()
    t = make(fake, "https://asr-proxy.example/v1/audio/transcriptions")
    assert [await t.transcribe(PCM) for _ in range(5)] == [""] * 5
    assert fake.requests == []
    assert refusals(caplog) == ["unknown_host"]


@pytest.mark.parametrize("host", ["openrouter.ai.evil.example", "evil-openrouter.ai",
                                  "api.deepgram.com.evil.example", "deepgram.com"])
async def test_lookalike_and_unsupported_hosts_are_refused(host):
    fake = FakeOpenRouter()
    t = make(fake, f"https://{host}/v1/audio/transcriptions")
    assert await t.transcribe(PCM) == ""
    assert fake.requests == []


async def test_a_trusted_host_named_by_the_operator_is_sent_without_a_key():
    fake = FakeOpenRouter()
    url = "https://asr.internal.example/v1/audio/transcriptions"
    t = make(fake, url, trusted="other.example, ASR.internal.example.")
    assert await t.transcribe(PCM) == "hello"
    assert [str(r.url) for r in fake.requests] == [url]
    assert "authorization" not in fake.requests[0].headers


async def test_a_trusted_host_may_be_plain_http():
    fake = FakeOpenRouter()
    url = "http://asr.internal.example:9000/v1/audio/transcriptions"
    assert await make(fake, url, trusted="asr.internal.example").transcribe(PCM) == "hello"


@pytest.mark.parametrize("url", [
    "http://api.openai.com/v1/audio/transcriptions",
    "http://openrouter.ai/api/v1/audio/transcriptions",
    "http://api.deepgram.com/v1/listen",
])
async def test_cleartext_urls_are_refused_before_any_request(url, caplog):
    fake = FakeOpenRouter()
    assert await make(fake, url).transcribe(PCM) == ""
    assert fake.requests == []  # no audio, and no ZDR lookup over plain http
    assert refusals(caplog) == ["cleartext"]


@pytest.mark.parametrize("url", [OPENROUTER_URL, OPENAI_URL])
async def test_without_its_key_the_route_is_not_ready_and_nothing_is_sent(url, caplog):
    fake = FakeOpenRouter()
    t = make(fake, url, keys={"anthropic": "sk-ant"})
    assert await t.ready() is False
    assert await t.transcribe(PCM) == ""
    assert fake.audio_posts() == []
    assert refusals(caplog) == ["no_key"]


async def test_a_provider_error_returns_nothing_and_logs_only_its_status(caplog):
    fake = FakeOpenRouter()
    fake.transcribe_status = 502
    with caplog.at_level(logging.DEBUG):
        assert await make(fake).transcribe(PCM) == ""
    assert events(caplog, "transcription.failed", "error") == ["status:502"]


async def test_a_key_out_of_credit_is_reported_until_a_call_succeeds_again():
    # QOR-4738: OpenRouter answers 402 when the key has run out of credit.
    fake = FakeOpenRouter()
    t = make(fake)
    assert t.error is None
    fake.transcribe_status = 402
    assert await t.transcribe(PCM) == ""
    assert t.error == "model_out_of_credit"
    fake.transcribe_status = 502  # any other failure says nothing new about credit
    await t.transcribe(PCM)
    assert t.error == "model_out_of_credit"
    fake.transcribe_status = 200
    assert await t.transcribe(PCM) == "hello"
    assert t.error is None


async def test_a_402_from_another_route_is_not_reported_as_openrouter_credit():
    fake = FakeOpenRouter()
    t = make(fake, DEEPGRAM_URL)
    fake.transcribe_status = 402
    assert await t.transcribe(PCM) == ""
    assert t.error is None


async def test_a_redirect_is_not_followed():
    fake = FakeOpenRouter()
    fake.transcribe_status = 307
    assert await make(fake).transcribe(PCM) == ""
    assert len(fake.requests) == 3  # two lookups and one post: no second hop


@pytest.mark.parametrize("env, message", [
    ({"BWAT_ASR_URL": "https://openrouter.ai./api/v1/audio/transcriptions"}, "BWAT_ASR_URL"),
    ({"BWAT_ASR_URL": "https://user:pw@openrouter.ai/api/v1/audio/transcriptions"},
     "BWAT_ASR_URL"),
    ({"BWAT_ASR_URL": "https://169.254.169.254/v1/audio/transcriptions"}, "BWAT_ASR_URL"),
    ({"BWAT_ASR_URL": "ftp://openrouter.ai/x"}, "BWAT_ASR_URL"),
    ({"BWAT_ASR_URL": "https://openrouter.ai:99999/x"}, "BWAT_ASR_URL"),
    ({"BWAT_ASR_MODEL": "../../keys"}, "BWAT_ASR_MODEL"),
    ({"BWAT_ASR_MODEL": "deepgram/nova-3?x=1"}, "BWAT_ASR_MODEL"),
    ({"BWAT_ASR_TRUSTED_HOSTS": "asr.example, not a host"}, "BWAT_ASR_TRUSTED_HOSTS"),
])
def test_a_malformed_transcription_setting_stops_the_bot_naming_only_the_variable(
        env, message):
    with pytest.raises(ConfigError) as caught:
        config_for(**env)
    assert message in str(caught.value)
    assert "pw" not in str(caught.value) and "keys" not in str(caught.value)


def test_the_defaults_are_openrouter_nova_3():
    config = Config.from_env({"BWAT_BACKEND_URL": "https://backend.test",
                              "BWAT_FLEET_CREDENTIAL": "bwf_" + "a" * 43})
    assert (config.asr_url, config.asr_model) == (OPENROUTER_URL, MODEL)
    assert config.asr_trusted_hosts == frozenset()


@pytest.mark.parametrize("route", ["endpoints_status", "zdr_status"])
@pytest.mark.parametrize("status", [404, 503])
async def test_a_policy_route_refusing_withholds_audio_even_with_a_readable_body(route, status):
    fake = FakeOpenRouter()
    setattr(fake, route, status)
    assert await make(fake).transcribe(PCM) == ""
    assert fake.audio_posts() == []


async def test_a_known_provider_is_never_sent_cleartext_even_when_trusted():
    fake = FakeOpenRouter()
    t = make(fake, "http://openrouter.ai/api/v1/audio/transcriptions", trusted="openrouter.ai")
    assert await t.transcribe(PCM) == ""
    assert fake.requests == []


@pytest.mark.parametrize("body", [{"text": 5}, {"text": None}, {}, ["hello"], "hello"])
async def test_an_answer_without_text_returns_nothing(body, caplog):
    fake = FakeOpenRouter()
    fake.transcribe_body = body
    assert await make(fake).transcribe(PCM) == ""
    assert events(caplog, "transcription.failed", "error") == ["unreadable_body"]


async def test_the_transcription_client_reaches_only_the_transcription_host():
    from bwat_bot.egress import EgressRefused
    fake = FakeOpenRouter()
    t = make(fake, OPENAI_URL)
    with pytest.raises(EgressRefused):
        await t._http.get("https://backend.test/v1/bot/settings")
    assert fake.requests == []
    await t.aclose()


async def test_direct_deepgram_sends_raw_audio_with_the_training_opt_out():
    fake = FakeOpenRouter()
    t = make(fake, DEEPGRAM_URL)
    assert await t.transcribe(PCM) == "hello"
    (post,) = fake.requests  # no policy lookup: the opt-out is per request
    assert post.url.host == "api.deepgram.com" and post.url.path == "/v1/listen"
    assert post.url.params.get("mip_opt_out") == "true"
    assert post.url.params.get("model") == "nova-3"
    assert post.headers["authorization"] == "Token dg-test"
    assert post.headers["content-type"] == "audio/wav"
    assert post.content.startswith(b"RIFF")


async def test_the_deepgram_opt_out_cannot_be_configured_off():
    fake = FakeOpenRouter()
    t = make(fake, DEEPGRAM_URL + "?mip_opt_out=false&model=nova-2&punctuate=true")
    await t.transcribe(PCM)
    (post,) = fake.requests
    assert post.url.params.get_list("mip_opt_out") == ["true"]
    assert post.url.params.get_list("model") == ["nova-3"]
    assert post.url.params.get("punctuate") == "true"  # other options are the operator's


async def test_deepgram_without_its_key_is_not_ready(caplog):
    fake = FakeOpenRouter()
    t = make(fake, DEEPGRAM_URL, keys={"openrouter": "sk-or-test"})
    assert await t.transcribe(PCM) == ""
    assert fake.requests == []
    assert refusals(caplog) == ["no_key"]


@pytest.mark.parametrize("body", [{"text": "hello"}, {"results": {"channels": []}},
                                  {"results": {"channels": [{"alternatives": [{}]}]}}])
async def test_a_deepgram_answer_of_the_wrong_shape_returns_nothing(body, caplog):
    fake = FakeOpenRouter()
    fake.transcribe_body = body
    assert await make(fake, DEEPGRAM_URL).transcribe(PCM) == ""
    assert events(caplog, "transcription.failed", "error") == ["unreadable_body"]


@pytest.mark.parametrize("name", [None, 0, False, ""])
async def test_endpoint_names_that_identify_nothing_withhold_audio(name, caplog):
    # Both lists carrying the same non-name would otherwise compare equal and open the guard.
    fake = FakeOpenRouter(served=(name,), zdr=(name,))
    t = make(fake)
    assert await t.ready() is False
    assert await t.transcribe(PCM) == ""
    assert fake.audio_posts() == []
    assert refusals(caplog) == ["lookup_failed"]
