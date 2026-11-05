"""The bot's one way out (T067): every HTTP request goes through GuardedTransport, which
allows only the configured hosts (the bwat backend, and the transcription host from Track 2)
and never a link-local or cloud-metadata address. Redirects are not followed.
"""
import ipaddress

import httpx


class EgressRefused(httpx.TransportError):
    """A request to a host the bot may not reach. Raised before any connection is made."""


# AWS's instance metadata over IPv6 is unique-local, not link-local.
METADATA_V6 = ipaddress.IPv6Address("fd00:ec2::254")
NAT64 = ipaddress.IPv6Network("64:ff9b::/96")


def blocked_address(host: str) -> bool:
    """True for a cloud-metadata or link-local address (169.254.0.0/16 and fe80::/10, which
    cover 169.254.169.254 and 169.254.170.2), also inside IPv4-mapped, 6to4 or NAT64 IPv6.
    The check is on the host as written; DNS names are not resolved here."""
    try:
        addr = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address):
        if addr == METADATA_V6:
            return True
        if addr.ipv4_mapped or addr.sixtofour:
            addr = addr.ipv4_mapped or addr.sixtofour
        elif addr in NAT64:
            addr = ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
    return addr.is_link_local


class GuardedTransport(httpx.AsyncBaseTransport):
    def __init__(self, allowed_hosts: set[str], inner: httpx.AsyncBaseTransport) -> None:
        self._allowed = frozenset(h.lower() for h in allowed_hosts)
        self._inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host.lower()
        if host not in self._allowed or blocked_address(host):
            raise EgressRefused("egress refused: host not allowed")
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()
