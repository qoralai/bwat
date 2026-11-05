# sdk

The Zoom Meeting SDK and the headless sample the bot's meeting app is built from are
**not** in git: the SDK is licensed and each install downloads its own copy (D92), and
the sample is fetched at its pinned commit and patched at build time.

| File | What |
|---|---|
| `zoom-sdk.lock` | The SDK version and its library's sha256; the sample's repository and commit |
| `bwat-sample.patch` | bwat's changes to the sample (below) |
| `prepare-vendor.sh` | Builds `vendor/` from an SDK archive: clones and patches the sample, checks the library against the lock |

Where to download the SDK and how to build from it: [Download the Meeting SDK](../../docs/onboarding.md#download-the-meeting-sdk).

```bash
bot/sdk/prepare-vendor.sh ~/Downloads/<the Linux SDK archive>
docker build --target zoom -t bwat-bot:zoom bot
```

The patch, against the sample at the locked commit:

- Joins with a Meeting SDK JWT minted by the backend (`jwt=` in the config), so the bot
  never holds the Zoom app's client secret; the local recording token goes in `join-token=`.
- Drops OpenCV and the raw video renderer and video source (bwat records audio only and
  never speaks, D122), and builds the release configuration.
- Shows the presence frame (`presence-frame=` in the config) as the bot's only video: one
  1280x720 I420 frame the bot renders before each join (`bwat_bot/presence.py`), sent twice a second
  through an external video source set before the join. bwat never speaks; it shows at most
  one still presence image (D195). With the camera off, or no frame, it shows none.
- Starts raw recording when the privilege comes with the join, and again once the
  "this meeting is being recorded" disclaimer is accepted.
- Reports what the bot needs as `BWAT_MEETING_STATUS_JSON` lines on stdout, which
  `bot/container/bridge.py` relays: the meeting status with its fail or end code, the
  meeting's UUID and topic once in, and authentication and recording-privilege results.
  The topic goes with the bot's authenticated occurrence report so the board can name
  the meeting even when the separate REST meeting-details lookup is unavailable.
- Posts in the meeting chat (D125): a thread reads `BWAT_CHAT_SEND {"text": ...}` lines
  from stdin, which `bot/container/bridge.py` writes, and each post goes to everyone from
  the glib loop, since the SDK drops a chat sent from another thread. Zoom's answer comes
  back as a `chat_sent` status line with its code. The reader starts once the bot is in
  the meeting, whether or not recording is granted.
- Handles SIGTERM and SIGINT on the glib loop instead of in a signal handler, so leaving
  and cleaning up never interrupt a chat send, which runs on the same loop.
- Starts the capture socket `/tmp/meeting.sock` (a literal in the sample, and the contract
  with the bridge), which the sample never started, and keeps it serving when the reader
  goes away instead of exiting.
