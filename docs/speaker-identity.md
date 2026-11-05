# Assigning spoken commitments

When a linked member says “I'll take that”, bwat can assign the card to their
member account even if their Zoom display name differs from their board name.
The writer still decides whether the words accept responsibility; identifying a
speaker alone is not a commitment. An owner a person set stays protected.

## Setup

1. Keep per-participant audio enabled. Mixed audio has no individual speaker ID.
2. Link each person's Zoom account to their bwat membership. The email is the source
   of truth: a signed join event that names both the person's Zoom account and its
   email links that account to the member with the same email, in an allowed domain,
   with no step from the person, once that member has signed in to bwat and Zoom's API
   confirms the email is that account's own. The confirmation needs the
   server-to-server app with `user:read:user:admin`, and only finds users on the
   install's own Zoom account. Without it, or for anyone else, pair through Zoom board
   sign-in (or the admin panel's member link).

   A link by email grants what pairing does: that Zoom account then signs in to the
   board inside Zoom as the member, with no pairing code.
3. Production only: the main app's event subscription (the manifest sets it) and its
   event secret; see onboarding, [Copy the main app's event secret](onboarding.md#copy-the-main-apps-event-secret).

Zoom's [join event](https://developers.zoom.us/docs/api/meetings/events/)
provides both the meeting-scoped `user_id` and the account's `participant_user_id`.
The [Meeting SDK user ID](https://developers.zoom.us/docs/meeting-sdk/linux/custom-ui/basic-features/in-meeting-user-info/)
changes when someone rejoins; it is not an account ID. Only the signed event maps
that audio stream to a linked, active member. Names, email addresses, deprecated
`id`, and `customer_key` are not used to establish this mapping. The event's email
only links an account to a member (step 2), and only when the same event names the
account: a guest's email, which comes without one, links nothing. The event's email
alone proves nothing (a registrant types theirs), so it links only when Zoom's API
answers the same address for that account, and that account is active (a pending
user's address is not verified). A member already linked to another
account, or an account another member holds, is never relinked by email. Each of
these fails closed; `zoom.email_link` logs `conflict`, `not_confirmed` or
`zoom_unavailable` as a warning, never the email or the account. A refusal from Zoom
that will not pass, such as the server-to-server app lacking `user:read:user:admin`,
answers every join alike, so it logs `zoom_unavailable` with Zoom's status at debug.

## Behavior and limits

- Mapping uses the meeting occurrence plus the audio participant ID. Rejoins get
  their own mapping; another meeting cannot reuse it. Conflicting mappings stay
  unresolved, including after a replay of the original event.
- Unknown, unlinked, inactive, logged-out, and external participants whose account
  ID Zoom withholds remain unassigned. Their displayed name cannot impersonate a
  linked member.
- A transcript saved without audio participant IDs matches speakers by exact name
  only, and its IDs cannot be rebuilt from names.
- The backend returns stored segments before the bot publishes the live feed.
  Transcript reads and the writer's final identity lookup use the same mapping.
  A join event or member link arriving during capture or model inference is picked
  up before the card is written.
- An event arriving after the card is written does not rewrite the card. A person can assign the card, or a later explicit commitment
  can update it under the usual writer rules.
- This covers spoken audio. Chat keeps its own attribution.
- Deleting a meeting removes its mappings; transcript retention removes them when
  the transcript expires. Mappings for meetings never stored expire on the same
  retention window. Late events cannot restore deleted or expired meeting mappings.
- Only occurrences with a bwat claim or saved meeting are recorded, with one
  exception: while auto-join is on and waits for the host, arrivals before the host
  are kept, and resolve once the host's arrival opens the claim. Those kept for a
  meeting bwat never attends are deleted when it ends, or after a day. Other arrivals
  before bwat is in the meeting (a person sends bwat by link, for example) are ignored.
- Opening the bwat panel inside the meeting identifies the viewer: the board sends
  Zoom's signed context with the viewer's own participant ID, and a linked member's
  speaker ID is recorded for a meeting bwat attends. Only the account is signed by
  Zoom here: the participant ID comes from the board itself, so a member could name
  another person's ID. This is an accepted gap, kept small: the panel only maps an ID
  nobody has mapped yet, and never changes or conflicts a mapping already made. A join event
  that later disagrees with a panel mapping marks it conflicted, which resolves to nobody
  (it fails closed).
- `transcript.stored` logs include `identified_speakers` and `unresolved_speakers`
  counts for each identity-aware batch. If every speaker stays unresolved, check
  webhook reachability and member links. Guests can legitimately remain unresolved;
  these counts alone do not prove webhook failure. No names or account IDs are logged.

## Verification in a real meeting

After deployment, link two members, give one a different Zoom display name, and
say “I'll send the notes to [other member]”. Check that the speaker owns the card
and its citation, not the recipient. Rejoin and repeat, then check an unlinked
guest using the same display name remains unassigned.
