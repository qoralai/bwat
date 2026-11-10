# Plugins

bwat has two kinds of plugin: the bwat plugin for Claude Code, which runs on each person's computer, and board plugins, which run inside a bwat install.

## The Claude Code plugin

The bwat plugin gives a Claude Code session bwat's hand-off inbox, meetings and transcripts. It also works in any other MCP client as a stdio MCP server.

- `/bwat:login` and `/bwat:logout` sign in to bwat or forget the sign-in.
- `/bwat:status` shows which bwat the session talks to and who is signed in.
- `/bwat:join` sends bwat to a Zoom meeting by its link, and `/bwat:recall` recalls it.
- `/bwat:cards` lists the cards written from a meeting.
- `/bwat:live` reads the live meeting's transcript and follows it.
- `/bwat:inbox-off` and `/bwat:inbox-on` take the session out of the board's Send to Claude list, or put it back.

How to install it and how it works: [the bwat plugin README](https://github.com/qoralai/bwat-plugin/blob/main/README.md).

## Board plugins

Board plugins add features to the board for installs that want them. A fresh install has them all off. An owner or admin turns each one on or off on the admin panel's Plugins page, and the change needs no restart. While a plugin is off, the board shows nothing from it, and its data stays.

### Goals

Sets the team's goals for a period and ties cards to them. The period is a week by default, or 2 weeks, a month or a quarter. Anyone can add a draft goal; an owner or admin promotes or dismisses it and records whether it was met, missed or carried to the next period. The board tags each card with the goal it serves and can show only one goal's cards.

### Jira

Files an open to-do or a risk in Jira Cloud with one press of Route to Jira. bwat files the card as a Task in one project, as one Jira account, and links the card to its issue. Set it up on the plugin's card on the Plugins page: the site address, the project key, the account email and an API token. Only Jira Cloud on an `atlassian.net` address is supported.
