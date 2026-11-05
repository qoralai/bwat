import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getJson, messageFor, ONCE, refetchOnForbidden, sendJsonForBody, sessionGone } from './api';
import { LoadError } from './LoadError';

/** GET /v1/console/google-signin: never a secret, only whether it is set and its last four. */
export type GoogleSignInRead = {
  signIn: 'google' | 'code';
  configured: boolean;
  webClientIds: string[];
  pluginClient: { id: string | null; secret: { set: boolean; last4: string | null } };
  domains: { effective: string[]; env: string[]; saved: string[] | null; revision: number | null; updatedAt: string | null };
};

const fetchGoogleSignIn = () => getJson<GoogleSignInRead>('/v1/console/google-signin');

/** What was typed, as a list: split on commas or spaces, trimmed, lower case, no repeats. */
const listOf = (text: string) => [...new Set(text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];

const SAVE_ERRORS: Record<string, string> = {
  stale: 'Someone else changed the domains meanwhile. Reload the page to see them. Nothing was saved.',
  forbidden: 'Only admins can change who signs in.',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="google-row">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

/** The allowed email domains: a field, Save, and a way back to the install's own list. */
function Domains({ read }: { read: GoogleSignInRead }) {
  const queryClient = useQueryClient();
  const { effective, env, saved, revision } = read.domains;
  const [text, setText] = useState(effective.join(', '));
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async (domains: string[] | null) =>
      (await sendJsonForBody('PUT', '/v1/console/google-signin/domains', { domains, expectedRevision: revision })) as GoogleSignInRead,
    // The field shows what is stored now; the field keeps focus, since the button that cleared it may be gone.
    onSuccess: (next) => {
      queryClient.setQueryData(['google-signin'], next);
      setText(next.domains.effective.join(', '));
      if (!next.domains.saved) input.current?.focus();
    },
    ...refetchOnForbidden(['google-signin']),
  });
  const typed = listOf(text);
  const changed = typed.join(',') !== effective.join(',');
  const source = saved
    ? `Saved here. It replaces the install’s own list${env.length > 0 ? ` (${env.join(', ')})` : ''}.`
    : 'From the install’s own settings (BWAT_ALLOWED_DOMAINS).';

  const error = save.error && !sessionGone(save.error) ? save.error : null;
  return (
    <div className="google-domains">
      <label htmlFor="google-domains">Allowed email domains</label>
      <p id="google-domains-help" className="muted small">
        Only people whose Google email is at one of these domains can sign in. Separate domains with commas. A change applies within 15
        seconds, without a restart.
      </p>
      <input
        ref={input}
        id="google-domains"
        type="text"
        value={text}
        spellCheck={false}
        autoComplete="off"
        placeholder="yourcompany.com"
        // Locked while a save is on its way, so its answer never overwrites newer typing.
        readOnly={save.isPending}
        aria-describedby={error ? 'google-domains-help google-domains-error' : 'google-domains-help'}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          save.reset();
          setText(e.target.value);
        }}
      />
      <p className="muted small">{source}</p>
      <p role="status" className="muted small">
        {save.isSuccess && 'Saved.'}
      </p>
      {error && (
        <p id="google-domains-error" role="alert" className="error">
          {error instanceof ApiError && error.code && !SAVE_ERRORS[error.code] && error.serverMessage
            ? error.serverMessage
            : messageFor(error, SAVE_ERRORS)}
        </p>
      )}
      <div className="google-actions">
        <button type="button" className="button primary" disabled={!changed || typed.length === 0 || save.isPending} onClick={() => save.mutate(typed)}>
          {save.isPending ? 'Saving…' : 'Save domains'}
        </button>
        {saved && (
          <button type="button" className="button quiet" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Use the install list
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * How people sign in: once Google sign-in is set up, one line and the allowed email domains;
 * until then, its two clients and where each is set. Owners and admins only; a member's page never asks.
 */
export function GoogleSignIn() {
  // Read once per visit: a refetch would move the revision under an edit, and a save would then drop another admin's change.
  const query = useQuery({ queryKey: ['google-signin'], queryFn: fetchGoogleSignIn, ...ONCE });
  const read = query.data;
  // The backend's configured covers the web sign-in only; the plugin's sign-in needs its own client too.
  const pluginReady = Boolean(read?.pluginClient.id && read.pluginClient.secret.set);
  return (
    <section className="block google-signin" aria-labelledby="settings-google-signin">
      <h4 id="settings-google-signin" className="eyebrow">
        Google sign-in
      </h4>
      <LoadError what="the sign-in settings" error={query.error} />
      {read?.signIn === 'code' && (
        <p>
          People sign in with this install’s code. Google sign-in isn’t used. To add it, run <code>./bwat setup --tier team</code> on the
          install’s computer.
        </p>
      )}
      {read?.signIn === 'google' &&
        (read.configured && pluginReady ? (
          <>
            <p className="google-line">
              Google sign-in: set up{' '}
              <span className="tick" aria-hidden="true">
                ✓
              </span>
            </p>
            <Domains read={read} />
          </>
        ) : (
          <>
            <p className="pill warn">{read.configured ? 'Plugin sign-in not set up' : 'Not set up'}</p>
            <Row label="Web app client ID">{read.webClientIds.length > 0 ? read.webClientIds.map((id) => <code key={id}>{id}</code>) : 'Not set'}</Row>
            <Row label="Web app client secret">Kept by the sign-in server, never shown here</Row>
            <Row label="Plugin client ID">{read.pluginClient.id ? <code>{read.pluginClient.id}</code> : 'Not set'}</Row>
            <Row label="Plugin client secret">
              {read.pluginClient.secret.set ? (read.pluginClient.secret.last4 ? `Set, ending ${read.pluginClient.secret.last4}` : 'Set') : 'Not set'}
            </Row>
            <Domains read={read} />
            <p className="muted small">
              The client IDs and secrets come from the install’s environment (BWAT_GOOGLE_CLIENT_ID, BWAT_GOOGLE_DESKTOP_CLIENT_ID and their
              secrets). Change them by running <code>./bwat setup</code> again. If they are set in your infrastructure, ask whoever manages
              this install.
            </p>
          </>
        ))}
    </section>
  );
}
