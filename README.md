# bwat

bwat listens in your Zoom meeting and turns each thing someone commits to into a card, with the sentence they said it in. Send a card to your own Claude Code session with one button, or file it in Jira once an admin turns Jira on.

## Start here

Open Claude Code in any folder and paste this line:

```text
Install bwat for me: clone https://github.com/qoralai/bwat.git, then follow its docs/setup-with-claude.md
```

Claude explains each step, and you type every secret into bwat's setup page ([what it follows](docs/setup-with-claude.md)).

Or:

- **On this computer, by yourself:** `./bwat setup --web` opens the setup page; `./bwat setup --tier local` does the same in the terminal.
- **For your team, on a cloud server:** follow [For the installer](docs/onboarding.md#for-the-installer) on that server, by hand or with Claude Code there reading it with you.
- **Joining a bwat someone already installed:** [For everyone else](docs/onboarding.md#for-everyone-else).

## Two ways

- **local:** on this computer, for you alone. You sign in with a code, and paste a meeting link to bring bwat in.
- **production:** on a cloud server, for your team. Google sign-in, the board inside Zoom, and bwat joins meetings on its own.

[Choose where bwat runs](docs/onboarding.md#choose-where-bwat-runs) compares them. [Before you start](docs/onboarding.md#before-you-start) lists what each way needs. Each company downloads the Zoom Meeting SDK itself: see [Download the Meeting SDK](docs/onboarding.md#download-the-meeting-sdk).

Inside one install, every member can read every meeting's transcript and cards, not just the meetings they were in: access is team-wide by design. Who can join a production install: [Who can sign in](docs/onboarding.md#who-can-sign-in). Someone who can't sign in sees nothing.

Jev, on unless you turn it off, makes cards appear within seconds: it sends recent transcript text and card content to TypeSafe through OpenRouter, and only while OpenRouter lists it as zero data retention. [Connect OpenRouter](docs/onboarding.md#connect-openrouter) says how to turn it off.

## What's here

| Folder | What |
|---|---|
| `backend/` | Identity, meeting allocation, Zoom events, transcripts, settings and secrets, the hand-off inbox and client sessions (TypeScript) |
| `bot/` | The participant in the meeting (Python, Zoom Meeting SDK) |
| `cards/` | The card writer (Python) |
| `web/` | The board, the view inside Zoom and the admin panel (TypeScript, React) |
| `setup/` | The `./bwat` installer |

The Claude Code plugin lives in [bwat-plugin](https://github.com/qoralai/bwat-plugin). To run the stack for development, see [backend/README.md](backend/README.md#local-stack-docker).

## License

bwat is source available under the [Elastic License 2.0](LICENSE). Third-party material it carries is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
