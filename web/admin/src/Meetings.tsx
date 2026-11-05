import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, getJson, sendJson, sendJsonForBody } from './api';

/** What people see of a claim, as GET /v1/allocations lists it. */
export type Allocation = {
  id: string;
  meeting_number: string | null;
  claim_state: 'pending' | 'claimed' | 'attending' | 'released' | 'refused';
  refused_reason: string | null;
  /** Why the last try to place it failed, while it is retried and after it gave up. */
  last_placement_failure: string | null;
  /** The meeting's title, once bwat has the meeting (by its occurrence). */
  meeting_title: string | null;
  error: string | null;
  created_at: string | null;
  joined_at: string | null;
  ended_at: string | null;
};

export const fetchAllocations = () => getJson<{ allocations: Allocation[] }>('/v1/allocations');

// How often the Overview reads what bwat is doing while the tab is visible.
export const POLL_MS = 10_000;

/** A Zoom meeting number as Zoom writes it: 812 3456 7890, 123 456 7890, 123 456 789. */
export function zoomNumber(number: string | null): string {
  if (number == null) return '—';
  if (!/^\d{9,11}$/.test(number)) return number;
  const head = number.slice(0, 3);
  const rest = number.slice(3);
  const cut = rest.length === 8 ? 4 : 3;
  return `${head} ${rest.slice(0, cut)} ${rest.slice(cut)}`;
}

const INVALID_LINK = "That doesn't look like a Zoom meeting link. Paste the full join URL (https://zoom.us/j/…).";

/** What a failed send or recall tells the admin; the server's codes, never shown raw. */
export function sendError(error: Error): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Check Recent meetings before sending again.';
  if (error.code === 'not_a_zoom_meeting_link' || error.code === 'invalid_body') return INVALID_LINK;
  if (error.code === 'not_onboarded') return 'bwat is not set up yet: the owner finishes onboarding first.';
  return 'Something went wrong. Check Recent meetings before sending again.';
}

// After a send or a recall, the sends, the bots and the newest meetings may have changed.
export function useRefreshAfter() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['allocations'] }),
      queryClient.invalidateQueries({ queryKey: ['fleet'] }),
      queryClient.invalidateQueries({ queryKey: ['meetings', 'first'], exact: true }),
    ]);
}

/** Recall one claim: PATCH /v1/allocations/{id} {recall: true}. A 409 not_live means it already ended. */
export function useRecall() {
  const refresh = useRefreshAfter();
  const recall = useMutation({
    mutationFn: (id: string) => sendJson('PATCH', `/v1/allocations/${id}`, { recall: true }),
    onSettled: refresh,
  });
  const failed = recall.error && !(recall.error instanceof ApiError && recall.error.code === 'not_live');
  return { recall, failed };
}
export type RecallMutation = ReturnType<typeof useRecall>['recall'];

export function SendForm() {
  const [link, setLink] = useState('');
  const refresh = useRefreshAfter();
  const send = useMutation({
    mutationFn: async (zoom_url: string) =>
      (await sendJsonForBody('POST', '/v1/allocations', { zoom_url })) as Allocation & { status?: string },
    onSettled: refresh,
    // The input clears only once the bot is known to be sent or already on its way.
    onSuccess: () => setLink(''),
  });
  return (
    <form
      className="send"
      aria-labelledby="send-heading"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate(link.trim());
      }}
    >
      <h3 id="send-heading">Send bwat to a meeting</h3>
      <div className="fields">
        <div className="field">
          <label htmlFor="send-meeting">Zoom meeting link</label>
          <input
            id="send-meeting"
            type="text"
            autoComplete="off"
            placeholder="https://zoom.us/j/1234567890?pwd=…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
        <button type="submit" className="button primary" disabled={!link.trim() || send.isPending}>
          Send bwat
        </button>
      </div>
      {send.isError && (
        <p role="alert" className="error">
          {sendError(send.error)}
        </p>
      )}
      <p role="status" className="muted">
        {send.data &&
          (send.data.status === 'already_claimed'
            ? `bwat is already on its way to or in meeting ${zoomNumber(send.data.meeting_number)}`
            : `Sending bwat to meeting ${zoomNumber(send.data.meeting_number)}`)}
      </p>
    </form>
  );
}

/** Recall, then a confirm step that recalls this meeting only. */
export function Recall({ id, meetingNumber, onRecall, recalling }: {
  id: string;
  meetingNumber: string;
  onRecall: (id: string) => void;
  recalling: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="button" disabled={recalling} onClick={() => setConfirming(true)}>
        Recall
      </button>
    );
  }
  return (
    <span className="confirming">
      <span>Recall bwat from {meetingNumber}?</span>{' '}
      <button
        type="button"
        className="button primary"
        aria-label={`Confirm recall from ${meetingNumber}`}
        disabled={recalling}
        onClick={() => {
          setConfirming(false);
          onRecall(id);
        }}
      >
        Recall
      </button>{' '}
      <button type="button" className="button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
