# bwat-bot

The participant bwat sends into a Zoom meeting. It joins with the Zoom Meeting SDK,
transcribes what it hears, sends the transcript to your bwat backend, and serves a live
feed the card writer follows. It never speaks; it shows at most one still presence image
as its video: the logo it ships with, or the picture an owner or admin uploads in the
settings (D196).

It talks to two places only: your bwat backend and the transcription service you
configure. Before it sends any audio it checks that the service does not train on it,
and if it cannot tell, it sends nothing.

## How it runs

One process per meeting, in its own container. The backend decides which meeting the bot
joins and hands it a short-lived Meeting SDK token, so the bot never holds your Zoom
app's client secret.

It posts in the meeting chat, to everyone, three times at most per meeting. On joining:
the to-dos and questions still open from the meeting's previous occurrence, or, when
nothing carried over, a one-line hello saying so (nothing, if the backend cannot say).
For a meeting with a fixed schedule (the backend gives the bot its scheduled end):
five minutes before the end, a warning with the meeting's open questions nobody owns;
at the end, ⏰. A post whose time had passed when the bot joined is skipped, and a
reconnect posts nothing again. A post Zoom refuses is logged by its code
(`zoom.chat_failed`), never retried. The admin's "Post to the meeting chat" setting is
off by default; off, the bot posts none of these. The bot reads it on joining, so a
change applies from the next meeting it joins.

Inside the image:

| Part | What |
|---|---|
| The meeting app | Zoom's headless Linux sample, patched (see [`sdk/`](sdk/README.md)) |
| `container/bridge.py` | Starts the meeting app and relays its status and audio |
| `bwat_bot/` | The bot: joins through the bridge, transcribes, reports to the backend |

## Building it

`./bwat setup` builds it for you from the Zoom Meeting SDK in your Downloads folder. By
hand, from the repository root:

```bash
bot/sdk/prepare-vendor.sh ~/Downloads/<the Linux x86_64 SDK archive>
docker build --target zoom -t bwat-bot:zoom bot
```

The Zoom Meeting SDK is never in this repository: each install downloads its own copy
under Zoom's licence.

Without the SDK, `docker build -t bwat-bot bot` builds the bot with a stand-in meeting,
for local stacks and tests.

## Configuration

Set by setup's compose file; read in [`bwat_bot/config.py`](bwat_bot/config.py):

| Variable | What |
|---|---|
| `BWAT_BACKEND_URL` | Your bwat backend |
| `BWAT_FLEET_CREDENTIAL` | The bot's credential with the backend |
| `BWAT_ASR_URL`, `BWAT_ASR_MODEL` | The transcription service and model (default: Deepgram Nova-3 through OpenRouter) |
| `BWAT_ASR_TRUSTED_HOSTS` | Other transcription hosts you vouch for as not training on audio; any other host is refused |
| `BWAT_FEED_PORT` | Where the card writer reads the live feed |

The picture the bot shows as its video is set in the admin settings (Meeting bot, "Picture"): before each join the bot fetches it (`GET /v1/bot/presence-image`, re-rendered only when its ETag changes), and with none uploaded it shows the logo it ships with (`presence/default.png`, baked into the image). A picture it cannot fetch or use is logged (`presence.fetch_failed`, `bot.presence_image_invalid`) and the bot shows the logo; it never keeps the bot out of the meeting.

Not set by setup: an operator override, for a local run or a fixed picture. Give the container the picture yourself (a mounted file or one baked into the image) and set:

| Variable | What |
|---|---|
| `BWAT_BOT_PRESENCE_IMAGE` | A path inside the container to a 16:9 picture (PNG or JPEG) the bot shows as its video instead of the settings' picture or the logo; the bot then fetches nothing. A picture it cannot use is logged (`bot.presence_image_invalid`) and the bot falls back to the settings' picture or the logo |

## Development

Python 3.12.

```bash
pip install -r requirements-dev.txt
ruff check . && pytest -q
```

## Logs

Logs carry events, never content: no meeting numbers, passcodes, names, what anyone
said, chat lines, tokens or keys, at any level.
