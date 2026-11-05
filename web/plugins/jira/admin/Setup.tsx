import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getJson, retryNetworkOnly, sendJsonForBody, sessionGone, useRefetchMeWhenSessionGone } from '../../../admin/src/api';
import { fetchCredentials, Last4, putSecret, removable as removableSecret, replaceSecret, SecretInput } from '../../../admin/src/Secrets';
import './jira.css';

/* The jira plugin's setup card on the panel's Plugins page (admin/src/pluginSetup.ts): Jira as
   one connection, the site, project and account email (the plugin's settings) and the account's
   API token (its secret) in one card. Connect saves what was typed, then asks the backend to
   check with Jira; the dot lights and the Route to Jira button rises onto the sample card only
   once Jira has said yes. */

/** A Jira setting as the page last read or saved it. */
type Setting = { value: unknown; revision: number | null };
type Check = 'connected' | 'refused' | 'no_project' | 'unreachable';

const WHY: Record<Exclude<Check, 'connected'>, string> = {
  refused: 'Jira refused this token.',
  no_project: "Jira has no such project for this account, or the account can't see it.",
  unreachable: "Jira couldn't be reached. Try again shortly.",
};

const STALE = 'Someone else changed the Jira settings while this page was open. Reload the page, then connect again.';
const API_TOKENS = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const SETTINGS = '/v1/console/plugins/jira/settings';
type SettingsRead = { canManage: boolean; settings: Record<'jira_site_url' | 'jira_project_key' | 'jira_account_email', Setting> };

/** A Jira site address as the backend stores it (backend/src/plugins/jira/jira.ts), `https://<name>.atlassian.net` with no path or trailing slash, or null when it is not one. */
function normalizeSiteUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // The Jira token is sent here: an Atlassian Cloud site over https only, no port or credentials, and the site itself, nothing after it.
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return null;
  if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname)) return null;
  return url.origin;
}

/** As the backend checks them (backend/src/plugins/jira/index.ts): one sentence per problem. */
function problemsWith(site: string, project: string, email: string): string[] {
  const problems: string[] = [];
  if (!normalizeSiteUrl(site)) problems.push("Jira site address must be your Jira site's address, like https://yourcompany.atlassian.net.");
  if (!/^[A-Z][A-Z0-9_]+$/.test(project)) problems.push('Jira project key must be a Jira project key, like ABC.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) problems.push('Jira account email must be an email address, like ops@yourcompany.com.');
  return problems;
}

const hostOf = (site: unknown) => (typeof site === 'string' && site ? site.replace(/^https:\/\//, '') : '');

/** Asks the backend to check the stored connection with Jira. */
const runCheck = async () => ((await sendJsonForBody('POST', '/v1/plugins/jira/check', {})) as { result: Check }).result;

/**
 * What Jira last said about the stored connection. All four values being set is not
 * enough: once they are, the page asks Jira, once per visit. Admin only, as the check is.
 */
function useJira() {
  const jira = useQuery({ queryKey: ['jira'], queryFn: () => getJson<{ enabled: boolean }>('/v1/plugins/jira/status'), retry: retryNetworkOnly });
  const enabled = Boolean(jira.data?.enabled);
  const check = useQuery({
    queryKey: ['jira-check'],
    queryFn: runCheck,
    enabled,
    retry: retryNetworkOnly,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  // A check that failed outright (5xx, network) said nothing about the connection.
  return { result: enabled ? (check.data ?? null) : null, checking: enabled && check.isPending, unchecked: enabled && check.isError };
}

/** The card, once the plugin's settings are read. */
export function JiraSetup() {
  const read = useQuery({ queryKey: ['jira-settings'], queryFn: () => getJson<SettingsRead>(SETTINGS), retry: retryNetworkOnly });
  useRefetchMeWhenSessionGone(read.error);
  if (read.error) {
    return sessionGone(read.error) ? null : (
      <p role="alert" className="error">
        We couldn&apos;t load the Jira settings. Reload the page to try again.
      </p>
    );
  }
  if (!read.data) {
    return (
      <p role="status" className="muted">
        Loading Jira…
      </p>
    );
  }
  const { jira_site_url: site, jira_project_key: project, jira_account_email: email } = read.data.settings;
  return <JiraConnection site={site} project={project} email={email} />;
}

function JiraConnection({ site, project, email }: { site: Setting; project: Setting; email: Setting }) {
  const queryClient = useQueryClient();
  const { result, checking, unchecked } = useJira();
  const secrets = useQuery({ queryKey: ['credentials'], queryFn: fetchCredentials, retry: retryNetworkOnly });
  const token = secrets.data?.find((s) => s.name === 'jira.api_token');
  const [form, setForm] = useState(false);
  const [typed, setTyped] = useState({ site: '', project: '', email: '' });
  // The token lives only in this state, never as a mutation variable.
  const [tokenTyped, setTokenTyped] = useState('');
  // A dot that turns green from a Connect made just now breathes once, and the token's new
  // last four roll in; one already green when the page opened does neither.
  const [fresh, setFresh] = useState(false);
  // What a Connect came to, for a screen reader; focus moves to the card's button.
  const [said, setSaid] = useState('');
  const action = useRef<HTMLButtonElement>(null);
  const connected = result === 'connected';

  const siteValue = typed.site || null;
  const projectValue = typed.project || null;
  const emailValue = typed.email.trim() || null;
  const problems = problemsWith(siteValue ?? '', projectValue ?? '', emailValue ?? '');
  const ready = problems.length === 0 && tokenTyped !== '';

  const connect = useMutation({
    mutationFn: async () => {
      setFresh(false);
      setSaid('');
      const changes: Record<string, { value: unknown; expectedRevision: number | null }> = {};
      if (siteValue !== site.value) changes.jira_site_url = { value: siteValue, expectedRevision: site.revision };
      if (projectValue !== project.value) changes.jira_project_key = { value: projectValue, expectedRevision: project.revision };
      if (emailValue !== email.value) changes.jira_account_email = { value: emailValue, expectedRevision: email.revision };
      if (Object.keys(changes).length > 0) {
        queryClient.setQueryData(['jira-settings'], await sendJsonForBody('PUT', SETTINGS, { changes }));
      }
      await putSecret(queryClient, 'jira.api_token', tokenTyped);
      return runCheck();
    },
    onSuccess: (checked) => {
      setTokenTyped('');
      setForm(false);
      // All four are set now; what Jira said is what the page shows, here and in the menu.
      queryClient.setQueryData(['jira-check'], checked);
      queryClient.setQueryData(['jira'], { enabled: true });
      setFresh(checked === 'connected');
      setSaid(checked === 'connected' ? `Connected to ${projectValue}` : WHY[checked]);
    },
    // A Connect that failed part way leaves the page unsure what is stored.
    onError: () => void queryClient.invalidateQueries({ queryKey: ['credentials'] }),
  });
  // Focus follows the card's button: after a Connect, a Cancel or a Disconnect, each of which
  // takes away the control that had it.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (connect.isSuccess || refocus) action.current?.focus();
  }, [connect.isSuccess, connect.submittedAt, refocus]);
  const disconnect = useMutation({
    mutationFn: () => sendJsonForBody('DELETE', '/v1/console/secrets/jira.api_token'),
    onSuccess: (next) => {
      setFresh(false);
      setSaid('Jira disconnected');
      setRefocus((n) => n + 1);
      queryClient.setQueryData(['jira'], { enabled: false });
      queryClient.removeQueries({ queryKey: ['jira-check'] });
      replaceSecret(queryClient, 'credentials', next);
    },
  });
  useRefetchMeWhenSessionGone(connect.error);
  useRefetchMeWhenSessionGone(disconnect.error);
  const failed = connect.error ?? disconnect.error;
  const open = () => {
    const text = (setting: Setting) => (typeof setting.value === 'string' ? setting.value : '');
    setTyped({ site: text(site), project: text(project), email: text(email) });
    setTokenTyped('');
    setForm(true);
  };

  // Only a stored token can be taken away; one set by the install's environment stays.
  const removable = !!token && removableSecret(token);
  const disconnectButton = (
    <button type="button" className="button remove" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
      Disconnect
    </button>
  );
  const key = String(project.value ?? '');
  let card;
  if (connect.isPending || checking) {
    card = (
      <div className="secret-row">
        <span className="dot" aria-hidden="true" />
        <span className="l">
          <b>Checking…</b>
          <small>
            Asking {hostOf(connect.isPending ? siteValue : site.value)} for project {connect.isPending ? projectValue : key}
          </small>
        </span>
      </div>
    );
  } else if (form) {
    card = (
      <form
        className="jira-form"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
      >
        <input
          type="text"
          aria-label="Jira site"
          placeholder="https://yourcompany.atlassian.net"
          autoFocus
          value={typed.site}
          onChange={(e) => setTyped({ ...typed, site: e.target.value })}
        />
        <span className="field">
          <input type="text" aria-label="Project key" placeholder="ABC" value={typed.project} onChange={(e) => setTyped({ ...typed, project: e.target.value })} />
          <input
            type="text"
            aria-label="Account email"
            placeholder="The account the tickets are created as"
            value={typed.email}
            onChange={(e) => setTyped({ ...typed, email: e.target.value })}
          />
        </span>
        <SecretInput aria-label="API token" value={tokenTyped} onChange={(e) => setTokenTyped(e.target.value)} />
        <p className="muted">
          The account&apos;s API token is at{' '}
          <a href={API_TOKENS} target="_blank" rel="noreferrer">
            {API_TOKENS}
          </a>
          .
        </p>
        {(typed.site !== '' || typed.project !== '') && problems.length > 0 && (
          <ul className="notice warn">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <span className="row">
          <button type="submit" className="button primary" disabled={!ready}>
            Check and connect
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setTokenTyped('');
              setForm(false);
              setRefocus((n) => n + 1);
            }}
          >
            Cancel
          </button>
        </span>
      </form>
    );
  } else if (connected) {
    card = (
      <div className="secret-row">
        <span className={fresh ? 'dot ok breathe' : 'dot ok'} aria-hidden="true" />
        <span className="l">
          <b>Connected to {key}</b>
          <small>
            {hostOf(site.value)} · as {String(email.value)} · token ending {token?.last4 ? <Last4 text={token.last4} roll={fresh} /> : 'unknown'}
          </small>
        </span>
        <button ref={action} type="button" className="button" onClick={open}>
          Replace token
        </button>
        {removable && disconnectButton}
      </div>
    );
  } else {
    card = (
      <div className="secret-row">
        <span className="dot" aria-hidden="true" />
        <span className="l">
          {unchecked ? (
            <b>Couldn&apos;t check Jira just now.</b>
          ) : (
            <>
              <b>Not connected</b>
              <small>{result ? WHY[result] : 'Connect to give cards a Route to Jira button.'}</small>
            </>
          )}
        </span>
        <button ref={action} type="button" className="button" onClick={open}>
          Connect Jira
        </button>
        {/* A stored token Jira refused, or one not checked, can still be taken away. */}
        {removable && disconnectButton}
      </div>
    );
  }
  return (
    <section className={fresh ? 'block jira fresh' : 'block jira'} aria-labelledby="settings-jira">
      <h4 id="settings-jira" className="eyebrow">
        Jira
      </h4>
      {card}
      <p role="status" className="visually-hidden">
        {said}
      </p>
      {failed && !sessionGone(failed) && (
        <p role="alert" className="error">
          {failed instanceof ApiError && failed.code === 'stale'
            ? STALE
            : failed instanceof ApiError && failed.status < 500
              ? failed === disconnect.error
                ? 'Jira could not be disconnected. Try again.'
                : 'Jira could not be connected: something was refused. Check the values and try again.'
              : "We couldn't confirm the change. Reload the page to see what is stored."}
        </p>
      )}
      {/* What the team gets on the board: an example, so hidden from screen readers. */}
      <div className="sample" aria-hidden="true">
        <span className="muted">A to-do on the board</span>
        <span>Move releases to a blue-green rollout</span>
        <span className={connected ? 'routebtn in' : 'routebtn'}>Route to Jira · {key || 'ABC'}</span>
      </div>
    </section>
  );
}
