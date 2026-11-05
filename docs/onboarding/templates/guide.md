# bwat onboarding

bwat listens in your Zoom meeting and turns each thing someone commits to into a card, with the sentence they said it in. Send a card to your own Claude Code session with one button.

One person installs bwat for the company using Google admin and Zoom admin access. Everyone else signs in and installs the plugin.

- [For the installer](#for-the-installer)
- [For everyone else](#for-everyone-else)
- [Your first meeting](#your-first-meeting)
- [If something doesn't work](#if-something-doesnt-work)

## For the installer

{{part start}}

{{part modes}}

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

{{steps ids=company,zoom-main,zoom-webhook,zoom-sdk,zoom-board,zoom-board-everyone,zoom-s2s,zoom-account level=4}}

### Run setup

{{steps ids=model-key,check-answers,install level=4}}

### Finish the company setup

{{steps ids=sign-in,claude-here,zoom-validate,zoom-add-main,auto-join level=4}}

#### Connect your Claude Code

For: Production on a cloud server.

Do [step 3 of For everyone else](#for-everyone-else), as each teammate will: the admin panel's **Members → Connect Claude Code** shows the two commands with your address filled in.

{{steps ids=share level=4}}

{{part delete-answers level=3}}

## For everyone else

{{part teammates level=0}}

## Your first meeting

{{steps ids=first-meeting show=text,fields,commands,shots,checks,when}}

## If something doesn't work

{{part troubleshooting level=0}}
