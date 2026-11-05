"""The bot's own ECS task ARN (QOR-4888), which the backend protects from scale-in while
the bot is in a meeting.

ECS names the task metadata endpoint in ECS_CONTAINER_METADATA_URI_V4; it is link-local
(169.254.170.2), which the egress guard refuses for every configured URL. This is the one
deliberate read outside it: once, at start, of exactly the address ECS set, never a URL an
operator or a backend supplies.
"""
import json
import urllib.request
from collections.abc import Mapping


def task_arn(env: Mapping[str, str]) -> str | None:
    """The task's ARN, or None off ECS or when the endpoint does not answer."""
    base = env.get("ECS_CONTAINER_METADATA_URI_V4", "").strip()
    if not base:
        return None
    try:
        with urllib.request.urlopen(f"{base}/task", timeout=2) as response:
            arn = json.loads(response.read()).get("TaskARN")
    except (OSError, ValueError):
        return None
    return arn if isinstance(arn, str) else None
