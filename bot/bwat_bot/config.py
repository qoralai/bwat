"""Runtime configuration from the environment. Secrets never appear in a repr."""
import ipaddress
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from bwat_bot.egress import blocked_address

log = logging.getLogger("bwat_bot")

FEED_PORT = 8771  # where the card service dials the feed (feed.py)

FLEET_CREDENTIAL = re.compile(r"bwf_[A-Za-z0-9_-]{43}")
# The transcription route (D139): OpenRouter's Deepgram Nova-3, the prototype's measured
# choice. An install may point elsewhere; the no-training guard decides whether audio goes.
ASR_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
ASR_MODEL = "deepgram/nova-3"
# A model id as providers name them, one or two segments. It goes into a URL path, so no
# segment may start with a dot and nothing may carry a query or another path.
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(/[A-Za-z0-9][A-Za-z0-9._:-]{0,99})?")
# The only hosts plain http may reach: the backend's compose service, which a single-host
# install reaches over its own compose network, and, with BWAT_LOCAL_STACK=1, loopback.
# Not any single label, which could be a metadata name.
COMPOSE_BACKEND = "backend"
LOCAL_HOSTS = {COMPOSE_BACKEND, "localhost", "127.0.0.1", "::1"}
# A DNS name of labels whose last label starts with a letter, so numeric or hex shorthands
# that a resolver would read as an IPv4 address are refused.
DNS_NAME = re.compile(
    r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z]([a-z0-9-]{0,61}[a-z0-9])?"
)


def canonical_host(host: str) -> bool:
    """A plain IP literal, or a DNS name that cannot be read as an IPv4 shorthand."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return bool(DNS_NAME.fullmatch(host))


class ConfigError(ValueError):
    """The environment cannot start a bot. The message names the variable, never its value."""


def checked_host(name: str, parts) -> str:
    """The URL's host, refused unless its port parses, it is canonical, and it is not a
    link-local or metadata address."""
    try:
        _ = parts.port  # raises for a port that isn't a number or is out of range
    except ValueError:
        raise ConfigError(f"{name} has an invalid port") from None
    host = parts.hostname or ""
    if not canonical_host(host):
        raise ConfigError(f"{name} host must be a DNS name or a plain IP address")
    if blocked_address(host):
        raise ConfigError(f"{name} points at a link-local or metadata address")
    return host


@dataclass(frozen=True)
class Config:
    backend_url: str
    backend_host: str
    fleet_credential: str = field(repr=False)
    asr_url: str
    asr_model: str
    # Hosts the operator vouches cannot train on the audio (self-hosted or contracted).
    asr_trusted_hosts: frozenset[str]
    local_stack: bool = False
    feed_port: int = FEED_PORT
    # BWAT_BOT_PRESENCE_IMAGE: a 16:9 picture the bot shows as its video; unset, none.
    presence_image: str | None = None
    # The bot's own ECS task, sent on register (ecs.py); None off ECS. Set by main, not the env.
    task_arn: str | None = None

    @property
    def asr_host(self) -> str:
        return urlsplit(self.asr_url).hostname

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Config":
        local_stack = env.get("BWAT_LOCAL_STACK") == "1"
        url = env.get("BWAT_BACKEND_URL", "").rstrip("/")
        parts = urlsplit(url)
        host = parts.hostname or ""
        if not host or parts.path or parts.query or parts.fragment or "@" in parts.netloc:
            raise ConfigError("BWAT_BACKEND_URL must be a bare origin, like https://bwat.example.com")
        checked_host("BWAT_BACKEND_URL", parts)
        if parts.scheme != "https" and not (
            parts.scheme == "http"
            and (host == COMPOSE_BACKEND or (local_stack and host in LOCAL_HOSTS))
        ):
            raise ConfigError("BWAT_BACKEND_URL must be https (http only to the compose backend "
                              "or, on a local stack, loopback)")
        credential = env.get("BWAT_FLEET_CREDENTIAL", "")
        if not FLEET_CREDENTIAL.fullmatch(credential):
            raise ConfigError("BWAT_FLEET_CREDENTIAL is missing or not a fleet credential")
        model = env.get("BWAT_ASR_MODEL") or ASR_MODEL
        if not MODEL_ID.fullmatch(model):
            raise ConfigError("BWAT_ASR_MODEL is not a model id, like deepgram/nova-3")
        if env.get("BWAT_PER_PARTICIPANT_AUDIO"):  # empty is unset, as before
            # Per-participant audio is always on: without it the bot cannot tell that everyone
            # else has left (QOR-5121). An old .env that still sets the switch starts anyway.
            log.warning("bot.per_participant_audio_switch_ignored")
        return cls(url, host, credential, _asr_url(env), model,
                   _trusted_hosts(env.get("BWAT_ASR_TRUSTED_HOSTS", "")), local_stack,
                   _feed_port(env.get("BWAT_FEED_PORT") or str(FEED_PORT)),
                   env.get("BWAT_BOT_PRESENCE_IMAGE") or None)


def _asr_url(env: Mapping[str, str]) -> str:
    """BWAT_ASR_URL. Whether audio may go there is the guard's call at run
    time (bwat_bot.transcription); this only refuses a URL that is malformed."""
    url = env.get("BWAT_ASR_URL") or ASR_URL
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname or "@" in parts.netloc \
            or parts.fragment:
        raise ConfigError("BWAT_ASR_URL must be an http(s) URL with a host and no user")
    checked_host("BWAT_ASR_URL", parts)
    return url


def _feed_port(value: str) -> int:
    if not (value.isdigit() and 0 < int(value) < 65536):
        raise ConfigError("BWAT_FEED_PORT must be a port number")
    return int(value)


def _trusted_hosts(value: str) -> frozenset[str]:
    hosts = {h.strip().rstrip(".").lower() for h in value.split(",")} - {""}
    if not all(canonical_host(h) for h in hosts):
        raise ConfigError("BWAT_ASR_TRUSTED_HOSTS must be a comma-separated list of hosts")
    return frozenset(hosts)
