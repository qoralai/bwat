"""Speech to text, only over a route that cannot train on meeting audio (D139, QOR-4557).

Zoom's API terms forbid letting AI train on meeting content. Through OpenRouter no
per-request control reaches the provider, but OpenRouter publishes which endpoints are Zero
Data Retention, and ZDR providers cannot train on the data. So audio goes to an OpenRouter
model only while every endpoint serving it is on that list, checked live because the list
changes when a provider's policy does. Deepgram called directly takes its documented
`mip_opt_out=true` on every request, which no setting can turn off. OpenAI's own API does
not train on API data. Any other host is refused unless the operator names it in BWAT_ASR_TRUSTED_HOSTS. Cleartext is
refused, except to a trusted host. There is no off switch: the guard fails closed, and audio
withheld from a closed route is dropped, never queued.

The key for a known host is the one GET /v1/bot/settings served for it; a trusted host gets
no key. The transcription host has its own HTTP client, allowed that host only, so a model
key never reaches the backend and the bot token never reaches the provider.

Adapted from the prototype's transcriber (docs/provenance.md). Logs name events and codes
only: never words heard, a key, or what a provider wrote back.
"""
import asyncio
import io
import logging
import time
import wave
from collections.abc import Callable, Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from bwat_bot.config import Config
from bwat_bot.egress import GuardedTransport

log = logging.getLogger("bwat_bot")

SAMPLE_RATE = 16_000  # the audio handed in: mono, 16-bit
TRANSCRIBE_SECONDS = 20.0
LOOKUP_SECONDS = 5.0
RECHECK_SECONDS = 3600.0  # a passing ZDR check holds this long
FAIL_HOLD_SECONDS = 30.0  # and a failed one this long, the audio withheld meanwhile
OPENROUTER = "openrouter.ai"
DEEPGRAM = "api.deepgram.com"
# The served model key (providerKeys) each known no-training host takes.
KEY_FOR_HOST = {OPENROUTER: "openrouter", "api.openai.com": "openai", DEEPGRAM: "deepgram"}
# OpenRouter answers 402 Payment Required when "your account or API key has insufficient
# credits", with a body of {"error": {"code": 402, "message": ...}}
# (https://openrouter.ai/docs/api-reference/errors). The status alone decides; the body is
# the provider's text and is never read or logged.
OUT_OF_CREDIT = "model_out_of_credit"


class Transcriber:
    def __init__(self, config: Config, *, keys: Callable[[], Mapping[str, str]],
                 inner: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._host = config.asr_host
        self._model = config.asr_model
        self._url = (_deepgram_url(config.asr_url, self._model) if self._host == DEEPGRAM
                     else config.asr_url)
        self._keys = keys
        self._clock = clock
        self._http = httpx.AsyncClient(
            transport=GuardedTransport({self._host}, inner or httpx.AsyncHTTPTransport()),
            follow_redirects=False,
            timeout=TRANSCRIBE_SECONDS,
        )
        known, trusted = self._host in KEY_FOR_HOST, self._host in config.asr_trusted_hosts
        # The refusal the configuration alone decides; only the key and ZDR change at run time.
        if urlsplit(self._url).scheme != "https" and (known or not trusted):
            # Cleartext would expose the audio, and to OpenRouter would let an on-path
            # attacker forge the ZDR list.
            self._fixed_refusal: str | None = "cleartext"
        else:
            self._fixed_refusal = None if known or trusted else "unknown_host"
        self._zdr: tuple[str | None, float] | None = None  # the last ZDR verdict, and until when
        self._lock = asyncio.Lock()
        self._state = "unknown"  # the last route state reported, so each change logs once
        # What the heartbeat reports (QOR-4738): set by a 402, cleared by the next success.
        self.error: str | None = None

    def clear_error(self) -> None:
        """Forgets the last error, when a new meeting starts."""
        self.error = None

    async def aclose(self) -> None:
        await self._http.aclose()

    async def ready(self) -> bool:
        """True while audio may go out: the route cannot train on it, and the key it needs
        has been served."""
        refusal = self._fixed_refusal
        if refusal is None and self._host in KEY_FOR_HOST and not self._key():
            refusal = "no_key"
        if refusal is None and self._host == OPENROUTER:
            refusal = await self._zdr_refusal()
        if refusal != self._state:
            self._state = refusal
            if refusal is None:
                log.info("transcription.open")
            else:
                log.error("transcription.refused", extra={"reason": refusal})
        return refusal is None

    async def transcribe(self, pcm: bytes) -> str:
        """The words in `pcm` (SAMPLE_RATE mono 16-bit), or "" when the route is closed or
        the call fails."""
        if not await self.ready():
            return ""
        text, error = await self._post(pcm)
        # OpenRouter's out-of-credit answer only: the banner sends people to its credits page.
        if error == "status:402" and self._host == OPENROUTER:
            self.error = OUT_OF_CREDIT
        elif error is None:
            self.error = None
        if error is not None:
            log.warning("transcription.failed", extra={"error": error})
            return ""
        return text

    async def _post(self, pcm: bytes) -> tuple[str, str | None]:
        """The words heard, or "" and the error code a log line may carry."""
        key = self._key()
        if self._host == DEEPGRAM:  # Deepgram's own API: the audio is the body
            request = {"headers": {"authorization": f"Token {key}", "content-type": "audio/wav"},
                       "content": _wav(pcm)}
        else:  # the OpenAI format, which OpenRouter speaks too
            request = {"headers": {} if key is None else {"authorization": f"Bearer {key}"},
                       "files": {"file": ("speech.wav", _wav(pcm), "audio/wav")},
                       "data": {"model": self._model, "language": "en",
                                "response_format": "json"}}
        try:
            response = await self._http.post(self._url, **request)
        except httpx.HTTPError as exc:
            return "", type(exc).__name__
        if response.status_code != 200:
            return "", f"status:{response.status_code}"
        try:
            body = response.json()
            text = (body["results"]["channels"][0]["alternatives"][0]["transcript"]
                    if self._host == DEEPGRAM else body["text"])
        except (ValueError, KeyError, IndexError, TypeError):
            text = None
        return (text.strip(), None) if isinstance(text, str) else ("", "unreadable_body")

    def _key(self) -> str | None:
        name = KEY_FOR_HOST.get(self._host)
        return None if name is None else self._keys().get(name)

    async def _zdr_refusal(self) -> str | None:
        """None while every endpoint serving the model is on OpenRouter's ZDR list. A pass
        holds RECHECK_SECONDS; a failure FAIL_HOLD_SECONDS, so a bad route neither looks up
        again for every segment nor reports itself once per segment."""
        async with self._lock:
            if self._zdr is not None and self._clock() < self._zdr[1]:
                return self._zdr[0]
            refusal = await self._look_up()
            # Stamped after the lookup, so a slow failure still gets the full hold.
            hold = RECHECK_SECONDS if refusal is None else FAIL_HOLD_SECONDS
            self._zdr = refusal, self._clock() + hold
            return refusal

    async def _look_up(self) -> str | None:
        # Routing preferences are not applied on /audio/transcriptions, so any one non-ZDR
        # endpoint could be the one that serves a request.
        base = f"https://{OPENROUTER}/api/v1"
        try:
            async with asyncio.timeout(LOOKUP_SECONDS):
                endpoints = await self._http.get(f"{base}/models/{self._model}/endpoints")
                listed = await self._http.get(f"{base}/endpoints/zdr")
            endpoints.raise_for_status()
            listed.raise_for_status()
            served = {e["name"] for e in endpoints.json()["data"]["endpoints"]}
            zdr = {e["name"] for e in listed.json()["data"]}
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
            return "lookup_failed"
        if not all(isinstance(name, str) and name for name in served):
            return "lookup_failed"  # names that identify no endpoint must not match each other
        return None if served and served <= zdr else "not_zdr"


def _deepgram_url(url: str, model: str) -> str:
    """The URL with Deepgram's training opt-out forced on, and the model and language set.
    Any other option the operator put in the URL stays."""
    parts = urlsplit(url)
    fixed = {"model": model.removeprefix("deepgram/"), "language": "en", "mip_opt_out": "true"}
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in fixed]
    return urlunsplit(parts._replace(query=urlencode(query + list(fixed.items()))))


def _wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return buf.getvalue()
