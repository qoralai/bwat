"""T067: the bot's Python code connects only to the bwat backend (and, from Track 2, the
transcription host). The Zoom SDK process is out of this scope."""
import pathlib
import re

import httpx
import pytest

from bwat_bot.backend import BackendClient, BackendError
from bwat_bot.config import Config, ConfigError
from bwat_bot.egress import EgressRefused, GuardedTransport

METADATA = ["169.254.169.254", "169.254.170.2", "[::ffff:169.254.169.254]", "[fe80::1]",
            "[fd00:ec2::254]", "[64:ff9b::a9fe:a9fe]", "[2002:a9fe:a9fe::1]"]
# Shorthands a resolver reads as 169.254.169.254, and names that are not canonical.
NON_CANONICAL = ["2852039166", "0xa9.0xfe.0xa9.0xfe", "169.254.43518", "0251.0376.0251.0376",
                 "bwat.example.com.", "bwat_example.com"]


def env(url: str, local: bool = False, credential: str = "bwf_" + "a" * 43) -> dict:
    values = {"BWAT_BACKEND_URL": url, "BWAT_FLEET_CREDENTIAL": credential}
    return values | ({"BWAT_LOCAL_STACK": "1"} if local else {})


@pytest.mark.parametrize("host", METADATA)
def test_the_backend_url_cannot_point_at_a_metadata_address(host):
    with pytest.raises(ConfigError):
        Config.from_env(env(f"https://{host}"))


@pytest.mark.parametrize("host", NON_CANONICAL)
def test_the_backend_host_must_be_canonical(host):
    with pytest.raises(ConfigError):
        Config.from_env(env(f"https://{host}"))


@pytest.mark.parametrize(
    ("url", "local"),
    [
        ("http://metadata", True),  # a local stack, but not the compose backend or loopback
        ("http://instance-data", True),
        ("https://:pw@bwat.example.com", False),
        ("http://bwat.example.com", False),
        ("http://bwat.example.com", True),  # local stack, but not a local host
        ("http://localhost:3000", False),  # loopback, but not a local stack
        ("ftp://backend", True),
        ("https://bwat.example.com/v1", False),  # an origin only
        ("https://user@bwat.example.com", False),
        ("https://bwat.example.com:abc", False),  # a port that isn't a number
        ("https://bwat.example.com:99999", False),  # or is out of range
        ("", False),
    ],
)
def test_the_backend_url_must_be_https_except_on_a_local_stack(url, local):
    with pytest.raises(ConfigError):
        Config.from_env(env(url, local))


@pytest.mark.parametrize("url", ["http://backend:3000", "http://127.0.0.1:3000",
                                 "http://localhost:3000"])
def test_a_local_stack_may_use_plain_http_to_a_local_host(url):
    assert Config.from_env(env(url, local=True)).backend_host in ("backend", "127.0.0.1",
                                                                  "localhost")


def test_an_install_reaches_its_backend_over_the_compose_network():
    # A single-host install: the bot and the backend share one compose network, so the
    # backend's service name over plain http is the route, not the public URL.
    assert Config.from_env(env("http://backend:3000")).backend_host == "backend"


def test_the_fleet_credential_is_checked_and_never_shown():
    with pytest.raises(ConfigError):
        Config.from_env(env("https://bwat.example.com", credential="bwb_" + "a" * 43))
    with pytest.raises(ConfigError):
        Config.from_env(env("https://bwat.example.com", credential="bwf_" + "a" * 43 + "\n"))
    config = Config.from_env(env("https://bwat.example.com"))
    assert config.fleet_credential not in repr(config)


async def request_to(host: str, allowed: set[str]) -> list[str]:
    reached: list[str] = []
    inner = httpx.MockTransport(lambda r: reached.append(r.url.host) or httpx.Response(200))
    async with httpx.AsyncClient(transport=GuardedTransport(allowed, inner)) as client:
        await client.get(f"https://{host}/")
    return reached


async def test_a_host_outside_the_allowlist_is_refused_before_connecting():
    with pytest.raises(EgressRefused):
        await request_to("elsewhere.example", {"bwat.example.com"})
    assert await request_to("bwat.example.com", {"bwat.example.com"}) == ["bwat.example.com"]


@pytest.mark.parametrize("host", METADATA)
async def test_a_metadata_address_is_refused_even_if_allowed(host):
    with pytest.raises(EgressRefused):
        await request_to(host, {host.strip("[]")})


async def test_a_redirect_is_never_followed(backend, config):
    reached: list[str] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        reached.append(request.url.host)
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest"})

    client = BackendClient(config, httpx.MockTransport(redirect))
    with pytest.raises(BackendError):
        await client.register("test")
    await client.aclose()
    assert reached == [backend.host]


def test_no_second_http_client_in_the_bot():
    # Every request goes through GuardedTransport; a new client library would bypass it.
    pattern = re.compile(r"\b(import requests|from requests|urllib\.request|import aiohttp|"
                         r"from aiohttp|http\.client|socket\.create_connection|"
                         r"httpx\.(get|post|request|Client)\b)")
    package = pathlib.Path(__file__).parents[1] / "bwat_bot"
    offenders = [p.name for p in package.rglob("*.py") if pattern.search(p.read_text("utf-8"))]
    # The one exception: ecs.py reads the task's own ARN, once, from the address ECS sets.
    assert offenders == ["ecs.py"]
