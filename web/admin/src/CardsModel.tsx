import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getJson, messageFor, sendJsonForBody, sessionGone, ONCE, refetchOnForbidden } from './api';
import { LoadError } from './LoadError';

/* The card writer's model, on Settings, Models, behind Change model. It saves on its own, not with
   the page's save bar: the backend checks the model with its endpoint first (it must be
   listed, and one tiny call must answer) and refuses with a plain reason. On OpenRouter, a
   model none of whose providers promises to keep no data is saved only after its warning. */

type Suggestion = { id: string; label: string; price: string | null };
type CardsModelRead = {
  endpoint: 'openrouter' | 'custom';
  host: string;
  model: string;
  default: string;
  saved: boolean;
  elsewhere: { model: string; host: string } | null;
  revision: number | null;
  listed: boolean;
  paused: { model: string; error: string } | null;
  suggestions: Suggestion[];
};

const fetchCardsModel = () => getJson<CardsModelRead>('/v1/console/cards-model');
/** The picker's value for "type a model id". */
const OTHER = '';
const SAVED_MS = 1800;

const SAVE_ERRORS: Record<string, string> = {
  stale: 'Someone changed the model meanwhile. Nothing was saved. Reload to see it.',
  forbidden: 'Only admins can change the model.',
  invalid_model: 'A model ID is one line of text, with no spaces. Nothing was saved.',
};

/** Why a save failed, in words; null when /whoami takes over (the session is gone). */
function failure(error: Error): string | null {
  if (sessionGone(error)) return null;
  // Only a 4xx refusal proves nothing was stored.
  if (!(error instanceof ApiError) || error.status >= 500) return "We couldn't confirm the save. Reload to see which model is in use.";
  // The backend's own plain reason why the model was refused.
  if (error.code === 'model_refused' && error.serverMessage) return error.serverMessage;
  return messageFor(error, SAVE_ERRORS);
}

/** `onCancel` folds the picker away again; none while the model in use needs a new pick. */
function Picker({ read, onCancel }: { read: CardsModelRead; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const suggested = read.suggestions.some((s) => s.id === read.model);
  const [pick, setPick] = useState(suggested ? read.model : OTHER);
  const [typed, setTyped] = useState(suggested ? '' : read.model);
  const [warning, setWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Where focus goes once the warning's buttons are gone.
  const pickerRef = useRef<HTMLSelectElement>(null);
  const model = (pick === OTHER ? typed : pick).trim();
  const closeWarning = () => {
    setWarning(null);
    pickerRef.current?.focus();
  };
  /** A new pick or a typed id: the last answer no longer applies to it. */
  const edited = () => {
    setWarning(null);
    save.reset();
  };
  const save = useMutation({
    mutationFn: async (acceptNoZdr: boolean) =>
      (await sendJsonForBody('PUT', '/v1/console/cards-model', {
        model,
        expectedRevision: read.revision,
        ...(acceptNoZdr && { acceptNoZdr: true }),
      })) as CardsModelRead,
    onMutate: () => {
      setSaved(false);
      setWarning(null);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['cards-model'], next);
      setSaved(true);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'no_zdr') setWarning(error.serverMessage ?? 'This model may keep meeting text.');
    },
    ...refetchOnForbidden(['me'], ['settings']),
  });
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);
  const message = save.isError && !warning ? failure(save.error) : null;
  return (
    <>
      <div className="setting">
        <label htmlFor="cards-model">Card writer model</label>
        <select
          id="cards-model"
          ref={pickerRef}
          value={pick}
          disabled={save.isPending}
          onChange={(e) => {
            setPick(e.target.value);
            edited();
          }}
        >
          {read.suggestions.map(({ id, label, price }) => (
            <option key={id} value={id}>
              {price ? `${label} · ${price}` : label}
            </option>
          ))}
          <option value={OTHER}>Another model ID…</option>
        </select>
        {pick === OTHER && (
          <span className="field">
            <input
              type="text"
              aria-label="Model ID"
              value={typed}
              disabled={save.isPending}
              placeholder={read.endpoint === 'openrouter' ? 'e.g. mistralai/mistral-large' : 'as your endpoint names it'}
              onChange={(e) => {
                setTyped(e.target.value);
                edited();
              }}
            />
          </span>
        )}
        <span className="row">
          <button
            type="button"
            className="button primary"
            // The model in use can always be saved again: it is checked again, which is how a
            // paused writer resumes and how a model that lost its ZDR endpoint reaches the warning.
            disabled={save.isPending || model === ''}
            onClick={() => save.mutate(false)}
          >
            {save.isPending ? 'Checking…' : 'Save model'}
          </button>
          {onCancel && (
            <button type="button" className="button quiet" disabled={save.isPending} onClick={onCancel}>
              Cancel
            </button>
          )}
          <span role="status" className="muted">
            {saved && 'Saved. The card writer uses it from its next pass.'}
          </span>
        </span>
      </div>
      {warning && (
        <div role="alert" className="notice warn">
          <p>{warning}</p>
          <p>
            <button
              type="button"
              className="button"
              onClick={() => {
                closeWarning();
                save.mutate(true);
              }}
            >
              Save anyway
            </button>{' '}
            <button
              type="button"
              className="button quiet"
              onClick={() => {
                closeWarning();
                save.reset();
              }}
            >
              Cancel
            </button>
          </p>
        </div>
      )}
      {message && (
        <p role="alert" className="error">
          {message}
        </p>
      )}
    </>
  );
}

/** The model in use, what is wrong with it, and the picker. */
export function CardsModel() {
  // Read once per visit, as the settings are: a refetch would move the revision under a pick in progress.
  const read = useQuery({ queryKey: ['cards-model'], queryFn: fetchCardsModel, ...ONCE });
  const [changing, setChanging] = useState(false);
  const data = read.data;
  // A paused writer, or a pick made for another endpoint, needs a model now: the picker shows.
  const needed = Boolean(data?.paused || data?.elsewhere);
  return (
    <section className="block" aria-labelledby="settings-cards-model">
      <h4 id="settings-cards-model" className="eyebrow">
        Card writer
      </h4>
      <LoadError what="the card writer's model" error={read.error} />
      {data && (
        <>
          <p className="muted">
            Writes the cards and the agenda summary, through {data.endpoint === 'openrouter' ? 'OpenRouter' : data.host}. In use:{' '}
            <b>{data.model}</b>
            {!data.saved && ", this install's default"}.
          </p>
          {data.paused && (
            <p role="alert" className="error">
              Paused: {data.paused.model} is unavailable, {data.paused.error}. No new cards are written until you save a model that works.
            </p>
          )}
          {data.elsewhere && (
            <p className="notice warn">
              {data.elsewhere.model} was picked for {data.elsewhere.host}, but the card writer now goes through {data.host}, so it uses the
              default. Pick a model for {data.host}.
            </p>
          )}
          {!data.listed && (
            <p className="muted">
              {data.endpoint === 'openrouter' ? "Prices can't be read from OpenRouter right now." : "The endpoint's model list can't be read right now."}
            </p>
          )}
          {needed || changing ? (
            <Picker read={data} onCancel={needed ? undefined : () => setChanging(false)} />
          ) : (
            <button type="button" className="button change-model" aria-expanded={false} onClick={() => setChanging(true)}>
              Change model
            </button>
          )}
        </>
      )}
    </section>
  );
}
