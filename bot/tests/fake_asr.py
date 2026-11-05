"""An in-process stand-in for OpenRouter: the two public policy routes the no-training guard
reads (the model's endpoints and the Zero Data Retention list) and the transcription route.
It also answers a transcription posted to api.deepgram.com in Deepgram's own shape.
It records every request, so a test can assert what left the process and where.
"""
import time

import httpx

from bwat_bot.config import Config
from bwat_bot.transcription import Transcriber

MODEL = "deepgram/nova-3"
NOVA = "Deepgram | deepgram/nova-3-20260714"
OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions"
DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"
PCM = b"\x00\x00" * 1600  # 100 ms of 16 kHz silence
KEYS = {"openrouter": "sk-or-test", "openai": "sk-oa-test", "deepgram": "dg-test"}


def config_for(url: str = OPENROUTER_URL, trusted: str = "", **env) -> Config:
    return Config.from_env({"BWAT_BACKEND_URL": "https://backend.test",
                            "BWAT_FLEET_CREDENTIAL": "bwf_" + "a" * 43,
                            "BWAT_ASR_URL": url, "BWAT_ASR_TRUSTED_HOSTS": trusted, **env})


def make(fake: "FakeOpenRouter", url: str = OPENROUTER_URL, *, trusted: str = "",
         keys: dict | None = None, clock=time.monotonic) -> Transcriber:
    """A transcriber for `url` that reaches only the fake, with KEYS served unless `keys`."""
    served = KEYS if keys is None else keys
    return Transcriber(config_for(url, trusted), keys=lambda: served,
                       inner=fake.transport(), clock=clock)


class FakeOpenRouter:
    def __init__(self, served=(NOVA,), zdr=(NOVA,), zdr_status=200, endpoints_status=200,
                 text="hello"):
        self.served = list(served)
        self.zdr = list(zdr)
        # A policy route's status. Its body stays well formed, so only the status refuses.
        self.zdr_status = zdr_status
        self.endpoints_status = endpoints_status
        self.transcribe_status = 200
        self.text = text
        self.transcribe_body: object = None  # a stand-in for the transcription answer
        self.policy: tuple[dict, dict] | None = None  # captured bodies, served as they are
        self.requests: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def audio_posts(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "POST"]

    def policy_gets(self) -> int:
        return sum(r.method == "GET" for r in self.requests)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET" and path == f"/api/v1/models/{MODEL}/endpoints":
            if self.policy is not None:
                return httpx.Response(self.endpoints_status, json=self.policy[0])
            return httpx.Response(self.endpoints_status, json={"data": {"id": MODEL, "endpoints": [
                {"name": n} for n in self.served]}})
        if request.method == "GET" and path == "/api/v1/endpoints/zdr":
            if self.policy is not None:
                return httpx.Response(self.zdr_status, json=self.policy[1])
            return httpx.Response(self.zdr_status, json={"data": [{"name": n} for n in self.zdr]})
        if request.method == "POST":
            if self.transcribe_status != 200:
                return httpx.Response(self.transcribe_status, text="the provider's own words",
                                      headers={"location": "https://openrouter.ai/elsewhere"})
            if self.transcribe_body is not None:
                return httpx.Response(200, json=self.transcribe_body)
            if request.url.host == "api.deepgram.com":  # Deepgram's own answer shape
                return httpx.Response(200, json={"results": {"channels": [
                    {"alternatives": [{"transcript": self.text, "confidence": 0.98}]}]}})
            return httpx.Response(200, json={"text": self.text})
        return httpx.Response(404)
