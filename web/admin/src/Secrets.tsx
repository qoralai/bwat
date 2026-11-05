import { useRef, useState, type InputHTMLAttributes } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { andList, ApiError, getJson, sendJsonForBody, sessionGone, messageFor, refetchOnForbidden } from './api';
import { LoadError } from './LoadError';

/** A stored secret's status: never its value (D141, D142). */
type SecretStatus = { set: boolean; source: 'store' | 'env' | 'unavailable' | null; last4: string | null };
type KeyEntry = SecretStatus & { provider: string };
export type CredentialEntry = SecretStatus & { name: string };

// Admin-only, GET included: a member's page never asks.
export const fetchModelKeys = async () => (await getJson<{ keys: KeyEntry[] }>('/v1/console/model-keys')).keys;
export const fetchCredentials = async () => (await getJson<{ secrets: CredentialEntry[] }>('/v1/console/secrets')).secrets;

/** Only a stored secret can be taken away; one set by the install's environment stays. */
export const removable = (status: SecretStatus) => status.set && status.source === 'store';

/** Each change answers with the secret's status, never its value: shown at once, in its list. */
export function replaceSecret(queryClient: QueryClient, queryKey: string, next: unknown) {
  const id = (x: unknown) => (x as { name?: string; provider?: string }).name ?? (x as { provider?: string }).provider;
  if (next) queryClient.setQueryData<unknown[]>([queryKey], (list) => list?.map((x) => (id(x) === id(next) ? next : x)));
}

/** Saves one of the panel's secrets (a credential) and shows its new status. */
export async function putSecret(queryClient: QueryClient, name: string, value: string) {
  replaceSecret(queryClient, 'credentials', await sendJsonForBody('PUT', `/v1/console/secrets/${name}`, { value }));
}

/** A field for a secret's new value. */
export function SecretInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="password"
      autoComplete="off"
      // Chromium ignores "off" on a password field; these keep 1Password and LastPass
      // from offering to store it.
      data-1p-ignore=""
      data-lpignore="true"
      {...props}
    />
  );
}

const SECRET_ERRORS: Record<string, string> = {
  invalid_key: 'A key is 8 to 512 characters, with no spaces. Nothing was saved.',
  invalid_value: 'A value is 1 to 512 characters, with no spaces. Nothing was saved.',
  not_set: 'Nothing is set yet.',
  forbidden: 'Only admins can manage keys and credentials.',
  store_not_configured: "This install can't store secrets yet (no encryption key). Nothing was saved.",
};

/** Why a change failed, in words. Never the value: the server does not echo it either. */
function SecretError({ error }: { error: Error }) {
  if (sessionGone(error)) return null;
  const message = !(error instanceof ApiError)
    ? "We couldn't confirm the change. Reload the page to see what is stored."
    : messageFor(error, SECRET_ERRORS);
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}

/** A secret's last four. Once a replaced one is saved, the new four roll in one by one. */
export function Last4({ text, roll }: { text: string; roll: boolean }) {
  return (
    <span key={text} className={roll ? 'digits roll' : 'digits'}>
      {[...text].map((c, i) => (
        <span key={i} style={roll ? { animationDelay: `${i * 40}ms` } : undefined}>
          {c}
        </span>
      ))}
    </span>
  );
}

function Status({ status, field, roll }: { status: SecretStatus; field: 'key' | 'value'; roll: boolean }) {
  if (status.source === 'unavailable') return <>The secret store couldn&apos;t be read, so whether this is set is unknown.</>;
  if (!status.set) return <>Not set</>;
  const from = status.source === 'env' ? "Set by this install's environment" : field === 'key' ? 'Key' : 'Set';
  if (!status.last4) return <>{from}</>;
  return (
    <>
      {from}
      {status.source === 'env' || field === 'value' ? ', ending ' : ' ending '}
      <Last4 text={status.last4} roll={roll} />
    </>
  );
}

type Check = 'valid' | 'invalid' | 'unreachable';

const CHECK: Record<Check, string> = {
  valid: 'the provider accepted this key.',
  invalid: 'the provider refused this key.',
  unreachable: "the provider couldn't be reached.",
};

/**
 * One secret: its status and last four, Replace (or Add) to type a new one, and Remove
 * for one this install stored, or `dismiss` for a row listed only to be added. Used for
 * the model keys (PUT {key}, checked with the provider as soon as it is saved) and the
 * Zoom credentials (PUT {value}). The typed value crosses the browser once and the field
 * empties on success.
 */
export function SecretRow({
  url,
  name,
  status,
  field,
  queryKey,
  validate: canValidate,
  startOpen = false,
  dismiss,
  required = false,
}: {
  url: string;
  name: string;
  /** Marked "required": bwat does not work without it. */
  required?: boolean;
  status: SecretStatus;
  field: 'key' | 'value';
  queryKey: string;
  validate?: boolean;
  startOpen?: boolean;
  dismiss?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(startOpen);
  const [typed, setTyped] = useState('');
  // The save reads the value from here, never as a mutation variable: TanStack keeps
  // variables in its mutation cache long after the row is gone.
  const typedRef = useRef('');
  const type = (value: string) => {
    typedRef.current = value;
    setTyped(value);
  };
  const [checked, setChecked] = useState<Check | null>(null);
  const [rolled, setRolled] = useState(false);
  const replace = (next: unknown) => replaceSecret(queryClient, queryKey, next);
  const check = useMutation({
    mutationFn: async () => (await sendJsonForBody('POST', `${url}/validate`, {})) as { result: Check },
    onSuccess: ({ result }) => setChecked(result),
    ...refetchOnForbidden(['me'], ['settings']),
  });
  const save = useMutation({
    mutationFn: () => sendJsonForBody('PUT', url, { [field]: typedRef.current }),
    onSuccess: (next) => {
      type('');
      setOpen(false);
      setChecked(null);
      setRolled(true);
      replace(next);
      // A model key is checked with its provider as it is entered.
      if (canValidate) check.mutate();
    },
    ...refetchOnForbidden(['me'], ['settings']),
  });
  const remove = useMutation({
    mutationFn: () => sendJsonForBody('DELETE', url),
    onSuccess: (next) => {
      setChecked(null);
      setRolled(false);
      replace(next);
    },
    ...refetchOnForbidden(['me'], ['settings']),
  });
  const busy = save.isPending || check.isPending || remove.isPending;
  const failed = [save, check, remove].find((m) => m.isError)?.error;
  const onRemove = removable(status) ? () => remove.mutate() : dismiss;
  const headingId = `secret-${url.replace(/[^a-z0-9]+/gi, '-')}`;
  return (
    <div role="group" className="secret" aria-labelledby={headingId}>
      <div className="secret-row">
        <span className="l">
          <b id={headingId}>
            {name}
            {required && <span className="req">required</span>}
          </b>
          <small>
            <Status status={status} field={field} roll={rolled} />
            {checked === 'valid' && (
              <span className="tick" role="img" title={`Check: ${CHECK.valid}`} aria-label={`Check: ${CHECK.valid}`}>
                ✓
              </span>
            )}
          </small>
        </span>
        <button type="button" className="button" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
          {status.set ? 'Replace' : 'Add'}
        </button>
        {onRemove && (
          <button type="button" className="button remove" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {open && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <SecretInput
            aria-label={`New ${name}${field === 'key' ? ' key' : ''}`}
            autoFocus
            value={typed}
            disabled={busy}
            onChange={(e) => type(e.target.value)}
          />
          <button type="submit" className="button primary" disabled={busy || typed === ''}>
            Save
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              type('');
              setOpen(false);
              dismiss?.();
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {checked && checked !== 'valid' && <p role="status">{`Check: ${CHECK[checked]}`}</p>}
      {failed && <SecretError error={failed} />}
    </div>
  );
}

/** The providers whose keys the backend stores, in page order; the first two bwat needs. */
const PROVIDERS = [
  { provider: 'openrouter', name: 'OpenRouter', required: true },
  { provider: 'deepgram', name: 'Deepgram', required: true },
  { provider: 'openai', name: 'OpenAI' },
  { provider: 'anthropic', name: 'Anthropic' },
  { provider: 'cerebras', name: 'Cerebras' },
  { provider: 'custom', name: 'Custom endpoint' },
] as const;

/** The two providers bwat needs, always; under Other, those that have a key, the rest under Add provider. */
export function ModelKeys() {
  const keys = useQuery({ queryKey: ['model-keys'], queryFn: fetchModelKeys });
  const [adding, setAdding] = useState<string[]>([]);
  const entryOf = (provider: string) => keys.data?.find((k) => k.provider === provider);
  const known = PROVIDERS.filter((p) => entryOf(p.provider));
  const needed = known.filter((p) => 'required' in p);
  const other = known.filter((p) => !('required' in p));
  const shown = other.filter((p) => {
    const entry = entryOf(p.provider)!;
    return entry.set || entry.source === 'unavailable' || adding.includes(p.provider);
  });
  const rest = other.filter((p) => !shown.includes(p));
  const row = (p: (typeof PROVIDERS)[number]) => {
    const { provider, name } = p;
    const entry = entryOf(provider)!;
    const pending = adding.includes(provider);
    return (
      <SecretRow
        key={provider}
        url={`/v1/console/model-keys/${provider}`}
        name={name}
        status={entry}
        field="key"
        queryKey="model-keys"
        validate
        required={'required' in p}
        startOpen={pending}
        dismiss={pending && !entry.set ? () => setAdding(adding.filter((p) => p !== provider)) : undefined}
      />
    );
  };
  return (
    <section className="block" aria-labelledby="settings-model-keys">
      <h4 id="settings-model-keys" className="eyebrow">
        Providers
      </h4>
      <LoadError what="the model keys" error={keys.error} />
      {needed.map(row)}
      {other.length > 0 && <h4 className="eyebrow">Other</h4>}
      {shown.map(row)}
      {rest.length > 0 && (
        <select aria-label="Add a provider" value="" onChange={(e) => setAdding([...adding, e.target.value])}>
          <option value="">Add provider…</option>
          {rest.map(({ provider, name }) => (
            <option key={provider} value={provider}>
              {name}
            </option>
          ))}
        </select>
      )}
    </section>
  );
}

/**
 * The Zoom credentials (D142), one row per app, because two Zoom apps with near-identical
 * fields got mixed up (the board's secret saved over the main app's, so the bot could not
 * join). Each row says which of its values are set and the client secret's last four;
 * its button opens the app's fields in place. How to set each app up is folded below.
 */
const ZOOM_APPS = 'https://marketplace.zoom.us/user/build';
const CREDENTIAL_GROUPS = [
  {
    id: 'zoom-main',
    title: 'Main app (the meeting bot)',
    what: 'The bot joins meetings with this app, and, in production mode, Zoom sends meeting events to bwat through it. If these are wrong, the bot cannot join.',
    where: 'The app you made from zoom-manifest.json (not the one whose name ends in "board"): Production, then App Credentials. In production mode only, the secret token is under Features, Access, Event Subscription.',
    unset: 'Not set',
    ending: 'zoom.client_secret',
    rows: [
      { name: 'zoom.client_id', label: 'Main app client ID', short: 'client ID' },
      { name: 'zoom.client_secret', label: 'Main app client secret', short: 'secret' },
      { name: 'zoom.webhook_secret', label: 'Main app secret token', short: 'secret token' },
    ],
  },
  {
    id: 'zoom-board',
    title: 'Board app (the board in Zoom)',
    what: 'The board inside Zoom signs each person in with this. If it is wrong, the board shows "Signing in" and cannot load the meeting.',
    where: 'The app you made from zoom-board-manifest.json (its name ends in "board"): Production, then App Credentials, Client Secret.',
    unset: 'Not set',
    ending: 'zoom.board_client_secret',
    rows: [{ name: 'zoom.board_client_secret', label: 'Board app client secret', short: 'client secret' }],
  },
  {
    id: 'zoom-s2s',
    title: 'Server-to-server app (optional)',
    what: 'With this, bwat records a meeting hosted in this Zoom account without the host allowing it, and auto-join can look up a meeting when it starts. Leave it empty and the host allows bwat to record when Zoom asks.',
    where: 'The Server-to-Server OAuth app (e.g. "bwat s2s"): App Credentials.',
    unset: 'Not set: hosts allow recording when Zoom asks',
    ending: 'zoom.s2s_client_secret',
    rows: [
      { name: 'zoom.s2s_account_id', label: 'Server-to-server account ID', short: 'account ID' },
      { name: 'zoom.s2s_client_id', label: 'Server-to-server client ID', short: 'client ID' },
      { name: 'zoom.s2s_client_secret', label: 'Server-to-server client secret', short: 'client secret' },
    ],
  },
] as const;
type CredentialGroup = (typeof CREDENTIAL_GROUPS)[number];

/** "a", "a and b", "a, b and c". */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One Zoom app: which of its values are set, and its fields once opened. */
function ZoomApp({ group, secrets }: { group: CredentialGroup; secrets: CredentialEntry[] }) {
  const [open, setOpen] = useState(false);
  const entryOf = (name: string) => secrets.find((s) => s.name === name);
  const shorts = (set: boolean) => group.rows.filter((r) => Boolean(entryOf(r.name)?.set) === set).map((r) => r.short);
  const [set, missing] = [shorts(true), shorts(false)];
  const last4 = entryOf(group.ending)?.set ? entryOf(group.ending)?.last4 : null;
  let summary: string;
  if (group.rows.some((r) => entryOf(r.name)?.source === 'unavailable')) summary = "The secret store couldn't be read, so what is set is unknown.";
  else if (set.length === 0) summary = group.unset;
  else if (group.rows.length === 1) summary = capital(set[0]!);
  else if (missing.length === 0) summary = `${capital(andList(set))} all set`;
  else summary = `${capital(andList(set))} set, ${andList(missing)} not set`;
  const headingId = `settings-${group.id}`;
  return (
    <div role="group" className="secret zoom-app" aria-labelledby={headingId}>
      <div className="secret-row">
        <span className="l">
          <b id={headingId}>{group.title}</b>
          <small>
            {summary}
            {last4 && (
              <>
                {group.rows.length === 1 ? ' ending ' : ' · ending '}
                <Last4 text={last4} roll={false} />
              </>
            )}
          </small>
        </span>
        <button type="button" className="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {missing.length === 0 ? 'Replace' : 'Add'}
        </button>
      </div>
      {open &&
        group.rows.map(({ name, label }) => {
          const entry = entryOf(name);
          return (
            entry && (
              <SecretRow key={name} url={`/v1/console/secrets/${name}`} name={label} status={entry} field="value" queryKey="credentials" startOpen />
            )
          );
        })}
    </div>
  );
}

/** The Zoom apps, in page order, then how to set them up, until all three are. */
export function Credentials() {
  const secrets = useQuery({ queryKey: ['credentials'], queryFn: fetchCredentials });
  const allSet = CREDENTIAL_GROUPS.every((group) => group.rows.every((r) => secrets.data?.find((s) => s.name === r.name)?.set));
  return (
    <>
      <LoadError what="the Zoom credentials" error={secrets.error} />
      {secrets.data && CREDENTIAL_GROUPS.map((group) => <ZoomApp key={group.id} group={group} secrets={secrets.data} />)}
      {secrets.data && !allSet && (
        <details className="howto">
          <summary>How to set this up</summary>
          {CREDENTIAL_GROUPS.map(({ id, title, what, where }) => (
            <p key={id}>
              <b>{title}.</b> {what} Where: {where}
            </p>
          ))}
          <p>
            <a href={ZOOM_APPS} target="_blank" rel="noreferrer">
              Open your Zoom apps
            </a>
          </p>
        </details>
      )}
    </>
  );
}
