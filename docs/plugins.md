# Board plugins

Board plugins add features to the board, inside a bwat install. A fresh install has them all off. An owner or admin turns each one on or off on the admin panel's Plugins page, and the change needs no restart. While a plugin is off, the board shows nothing from it, and its data stays.

For the plugin that connects your agent to bwat (Claude Code, or any other MCP client), see [the bwat plugin README](https://github.com/qoralai/bwat-plugin/blob/main/README.md).

## Goals

Sets the team's goals for a period and ties cards to them. The period is a week by default, or 2 weeks, a month or a quarter. Anyone can add a draft goal; an owner or admin promotes or dismisses it and records whether it was met, missed or carried to the next period. The board tags each card with the goal it serves and can show only one goal's cards.

## Jira

Files an open to-do or a risk in Jira Cloud with one press of Route to Jira. bwat files the card as a Task in one project, as one Jira account, and links the card to its issue. Set it up on the plugin's card on the Plugins page: the site address, the project key, the account email and an API token. Only Jira Cloud on an `atlassian.net` address is supported.
