# Install bwat with Claude Code

This page is a guide written for Claude Code: Claude reads it and walks you through
installing bwat on this computer. It explains each step before it does it, and tells you
where to click. What bwat is: [the README](https://github.com/qoralai/bwat#start-here).

## Start here

Open Claude Code in any folder and paste this line:

```text
Install bwat for me: clone https://github.com/qoralai/bwat.git, then follow its docs/setup-with-claude.md
```

{{steps ids=before-you-start show=text}}

Installing for a team on a cloud server instead? Follow the production steps of
[bwat onboarding](onboarding.md#for-the-installer) on that server; this guide installs bwat
on this computer.

<!-- bwat:claude-only -->
## For Claude: how to run this install

You are installing bwat on this person's computer. They may not be technical. They
should understand what is happening at every step, so explain before you act. Follow the
parts below in order, and the rules the whole time. `<bwat>` in this guide means the full
path of the folder bwat is cloned into (part 4).

### Rules for the whole install

- **This computer only.** If they want bwat for their team, stop: this guide installs bwat on
  this computer. Ask where bwat will run, then follow the production steps of
  docs/onboarding.md (For the installer) on that server.
- **Explain, then act.** Before each step, say in one or two plain sentences what it is
  for and what will happen. Avoid jargon; when you must use a word like Docker, say what
  it is.
- **The page leads.** The person does every step on the setup page: it shows one step
  at a time, asks for each answer and secret, and moves on by itself. You answer what
  they ask, say what a step is for, and explain any message it shows. Never fill in the
  page or move it for them.
- **One step at a time.** When they ask how to do a step, tell them exactly where to
  click, then wait for them to say it is done.
- **Secrets never go through chat.** Never ask for a secret, and if the person starts to
  paste one, stop them. They type each one into the setup page; `get_state` shows you
  only its last four characters. bwat's sign-in code is a secret too: they type it only
  into bwat's sign-in page.
- **Never read `bwat.answers`.** It holds the secrets. Do not open, print or search it
  in any way. The page writes it.
- **The setup page runs the install.** The only bwat command you run yourself is
  `<bwat>/bwat setup --web` (part 5). Never run `./bwat setup` (with `-y` or without),
  `./bwat prep`, `./bwat secret` or `./bwat plugin`, and never call `run_command` to start
  the install or the plugin (the one exception is after a Rosetta fix, part 6): the page
  writes the answers file itself, starts the install once OpenRouter and Zoom are done,
  and installs the Claude Code plugin once the person has signed in.
- **Never download the Zoom Meeting SDK yourself.** The person downloads it from their own
  Zoom app, and the page finds it in their Downloads folder. Never copy it anywhere: Zoom's
  licence is under "Download the Meeting SDK" in `<bwat>/docs/onboarding.md`.
- **The person does the clicking.** Do not drive their browser. Never open, read or
  screenshot a page that shows a secret: Zoom's App Credentials pages, and OpenRouter's
  key page. Never open openrouter.ai yourself.
- **A cloud install runs on the cloud server.** If the person asks for a cloud or team
  install, never stop this computer's setup page to start one. Say what the server needs
  (the production steps of [bwat onboarding](onboarding.md#for-the-installer)) and keep
  going here unless they say stop.
- **Stay on this path.** If something fails, read the message the setup page or the
  command gave, tell the person in plain words what it means, and fix only that. The
  table under "If something doesn't work" in `<bwat>/docs/onboarding.md` covers the
  usual problems. Ask before doing anything this guide does not describe.

### 1. Find where you are

- If you have the bwat-onboard tools (`get_state`, `get_guide` and the others), this is
  the second half, after the restart: go to part 5.
- If this person already has a bwat clone, the download is done: use it and skip the
  clone in part 4.
- If the person says carry on after restarting Claude Code for the plugin, go to part 7,
  step 2.

### 2. Say what is going to happen

Tell the person, in your own words:

- bwat will run on this computer only, inside Docker (a program that runs other
  programs in their own sealed box). Only they will use it.
- You will check this computer, download bwat, connect this Claude Code to bwat's setup
  page, and restart Claude Code once. Then the setup page walks them through seven steps
  in three groups: **OpenRouter** (the AI service that writes the cards, paid from their
  credit), **Zoom** and **bwat**. At the end they restart Claude Code once more.
- They type every secret into the setup page, never into the chat.

Then ask, and wait for each answer:

1. Do you have admin on your company's Zoom account? If not, stop: someone with Zoom admin
   has to do the install.
2. Please open https://openrouter.ai/settings/credits and tell me: is your balance above
   zero? If not, they add a few dollars there now. Without credit, bwat writes no cards.

### 3. Check this computer

Explain: this checks which computer this is, that git (which downloads bwat) is there,
and that Docker is running. Then run:

```sh
uname -sm; git --version; docker version --format '{{.Server.Version}}'
```

`Darwin arm64` is a Mac with Apple silicon. If git is missing on a Mac, macOS offers to
install the command line developer tools: ask the person to accept. If Docker gives no
server version, ask them to install
[Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it. Then run
the check again.

On Windows, run every command in Git Bash.

### 4. Download bwat and connect it to Claude Code

1. Explain: you will download bwat with git. Clone it where this person usually keeps
   their code; if you can't tell, ask them where. Then run, from that folder:

   ```sh
   git clone https://github.com/qoralai/bwat.git
   ```

2. Explain: you will add bwat's setup helper to Claude Code, in this folder only, so you
   can see where they are on the setup page and read what it says, and answer their
   questions about it. It is only for setup. Ask before you run it. Run it in the folder
   this Claude Code was started in, not inside the clone: Claude Code loads the helper
   only in the folder it was added in, and it restarts in the folder it was started in.

   ```sh
   cd "<start>" && claude mcp add -s local bwat-onboard -- "<bwat>/bwat" onboard mcp
   ```

   `<start>` is the folder this Claude Code was started in.

3. Explain: Claude Code loads a new helper only when it starts. Ask the person to type
   `/exit`, then start Claude Code again in the same folder with `claude --continue`, and
   say "carry on". Stop here until they are back.

### 5. Open the setup page

Explain: the setup page is a page in their browser that holds every step, keeps their
answers, and installs bwat when they are done. It runs on this computer only.

Start it in the background, because it keeps running while they work:

```sh
<bwat>/bwat setup --web
```

It opens their browser and prints a link: give them the link in case no browser opened.
Then call `get_state` to check you can reach the page.

### 6. Go through the setup page

The page leads. It shows one step at a time, with a row of dots above it for the seven
steps, and each step moves on by itself once it is done. The person works through it;
you stay beside them:

1. Tell them to follow the page, and to ask you whenever a step is unclear.
2. When they ask, `get_state` shows which steps are done, so you know where they are.
   Say what that step is for and where to click, as it says in
   `<bwat>/docs/onboarding.md` (`get_guide` gives each step's id and title).
3. If the page shows an error, read it with them and say in plain words what it means.

The steps, in order, by the id `get_state` uses:

```text
OpenRouter:
{{steps ids=model-key format=claude-page flows=local}}

Zoom. The page saves the owner's email as Zoom's contact email too: never ask for it.
{{steps ids=owner-local,company,zoom-main,zoom-sdk format=claude-page flows=local show=title,text,fields,checks,when}}

bwat: once OpenRouter and Zoom are done, the page starts the install by itself. Tell the
person it takes several minutes, most of it building the meeting bot, and follow it with
command_output setup until it says bwat is installed and running. If the install, or the
page, says Docker Desktop is using Rosetta, only then walk the person through the row
"Setup says Docker Desktop is using Rosetta" under "If something doesn't work" in
<bwat>/docs/onboarding.md; once Docker is back, start the install again with
run_command setup. Then:
{{steps ids=sign-in format=claude-page flows=local show=title,text,fields,checks,when}}
The page shows the sign-in code once. Tell the person to keep it somewhere safe, such as
a password manager: they need it again to sign in from Claude Code.
{{steps ids=claude-here format=claude-page flows=local show=title,text,checks,when}}
```

The page installs the bwat plugin by itself once the person has signed in: follow it with
`command_output plugin`.

### 7. Connect Claude Code to bwat

1. Explain: the bwat plugin lets this Claude Code receive the cards they send it, and
   Claude Code loads it only when it starts. Restart as in part 4, step 3.
2. They type `/bwat:login` and finish signing in in the browser with their sign-in code
   and email, then `/bwat:status` to check it shows their account.

Once Claude Code is connected, the setup page shows **bwat is ready** with the Zoom
account settings to check (recording, meeting access and Zoom Apps). Walk them through
that table. The page then deletes `bwat.answers` and its own records, and closes. bwat
keeps running.

### 8. The first meeting

Walk the person through it. `<address>` is bwat's address: `get_state` gives it.

{{steps ids=first-meeting show=text,fields,commands,checks,when}}

When the card reaches this session, read it with the bwat inbox tools and tell the person
what it asks. Tell them bwat is installed. To run the install again or change an answer later, they
run `./bwat setup --web` in the bwat folder to open the setup page.
<!-- bwat:end-claude-only -->
