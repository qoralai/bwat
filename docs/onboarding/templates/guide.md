# bwat onboarding

What bwat is, and the one line that installs it with Claude Code: [the README](https://github.com/qoralai/bwat#start-here).

One person installs bwat. On a cloud server that person needs Google admin and Zoom admin access; everyone else signs in and installs the plugin. Where the two ways differ, a step shows them side by side.

- [Choose where bwat runs](#choose-where-bwat-runs)
- [For the installer](#for-the-installer)
- [For everyone else](#for-everyone-else)
- [Your first meeting](#your-first-meeting)
- [If something doesn't work](#if-something-doesnt-work)

## Choose where bwat runs

{{part modes level=0}}

## For the installer

{{part start}}

{{steps ids=before-you-start,prerequisites}}

{{part download}}

{{steps ids=answers-file}}

### Choose your address

{{part address-intro level=0}}

{{steps ids=owner-local,address-server level=4}}

### Set up Google sign-in

{{part google-intro level=0}}

{{steps ids=google-web,google-desktop level=4}}

### Set up Zoom

{{part zoom-intro level=0}}

{{steps ids=company,zoom-main,zoom-sdk,zoom-s2s,zoom-board,zoom-board-everyone,zoom-account level=4}}

### Run setup

{{steps ids=model-key,check-answers,install level=4}}

### Finish the company setup

{{steps ids=sign-in,claude-here,zoom-validate,auto-join,share level=4}}

{{part who-can-sign-in level=4}}

{{part delete-answers level=3}}

## For everyone else

{{part teammates level=0}}

## Your first meeting

{{steps ids=first-meeting show=text,fields,commands,shots,checks,when}}

## If something doesn't work

{{part troubleshooting level=0}}
