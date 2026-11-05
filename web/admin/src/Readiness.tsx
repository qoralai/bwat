import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSettings, type AutoJoin } from './settingsRead';

/** Automatic joining's state, in one sentence. */
export const setupSentence = (autoJoin: AutoJoin, ready = autoJoin.effective) =>
  ready
    ? 'Automatic joining is ready for meetings in your Zoom account.'
    : autoJoin.requested
      ? 'Automatic joining is waiting for setup.'
      : 'Automatic joining is off.';

/**
 * What Recheck setup checks, each matched to the backend's problems by what they name.
 * The backend checks that a bot is ready, not that its SDK was downloaded, and the
 * server-to-server app's access to the account, not one meeting.
 */
const SETUP_CHECKS: readonly (readonly [name: string, names: RegExp])[] = [
  ['Main Zoom app credentials', /main Zoom app’s (Meeting SDK|webhook)/],
  ['Meeting events from Zoom', /meeting event/i],
  ['Zoom account access', /server-to-server|account access|temporarily unavailable/],
  ['A meeting bot is ready', /\bbot\b/i],
];
const checkOf = (problem: string) => SETUP_CHECKS.findIndex(([, names]) => names.test(problem));
/** The check the backend's notices belong to: all are about the server-to-server app. */
const ZOOM_ACCESS = SETUP_CHECKS.findIndex(([name]) => name === 'Zoom account access');
/** No meeting event has arrived yet: nothing failed, the check has simply not seen one. */
const WAITING = /^Waiting for a verified meeting event/;
/** The checks that pass in `now` and failed in `before`. */
const newlyPassing = (before: AutoJoin, now: AutoJoin) =>
  SETUP_CHECKS.map((_, i) => i).filter((i) => before.problems.some((p) => checkOf(p) === i) && !now.problems.some((p) => checkOf(p) === i));

/** How long after a recheck the last of `lit` checks has lit: the box changes then. */
const settleMs = (lit: number[]) => Math.max(0, lit.length - 1) * 120 + 250;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Automatic joining's state and its four checks, with Recheck setup. A recheck reads the
 * settings again into the shared read and lights the checks that now pass in turn, 120ms
 * apart; the box's words follow once they have.
 */
export function Readiness({ autoJoin }: { autoJoin: AutoJoin }) {
  const queryClient = useQueryClient();
  const [lit, setLit] = useState<number[]>([]);
  const [ready, setReady] = useState(autoJoin.effective);
  useEffect(() => {
    if (lit.length === 0 || reducedMotion()) return setReady(autoJoin.effective);
    const timer = setTimeout(() => setReady(autoJoin.effective), settleMs(lit));
    return () => clearTimeout(timer);
  }, [autoJoin, lit]);
  const recheck = useMutation({
    mutationFn: fetchSettings,
    onSuccess: (checked) => {
      // Only a check that changed moves, and only once the recheck has answered.
      setLit(checked.autoJoin ? newlyPassing(autoJoin, checked.autoJoin) : []);
      queryClient.setQueryData(['settings'], checked);
    },
  });
  const other = autoJoin.problems.filter((p) => checkOf(p) === -1);
  return (
    <>
      <div className={ready ? 'setup' : 'setup warn'}>
        <p>{setupSentence(autoJoin, ready)}</p>
        <button type="button" className="link" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
          {recheck.isPending ? 'Checking setup…' : 'Recheck setup'}
        </button>
      </div>
      <ul className="checks">
        {SETUP_CHECKS.map(([name], i) => {
          const problems = autoJoin.problems.filter((p) => checkOf(p) === i);
          const turn = lit.indexOf(i);
          return (
            <li key={name}>
              <span
                className={`dot${problems.length ? '' : ' ok'}${turn >= 0 ? ' lit' : ''}`}
                style={turn >= 0 ? { animationDelay: `${turn * 120}ms` } : undefined}
                aria-hidden="true"
              />
              <span className="name">{name}</span>
              {problems.map((p) => (
                <small key={p}>{WAITING.test(p) ? 'Not seen yet' : p}</small>
              ))}
              {i === ZOOM_ACCESS && (autoJoin.notices ?? []).map((n) => <small key={n}>{n}</small>)}
              {i === 1 && !problems.length && autoJoin.lastEventAt && <small className="muted">Last seen {new Date(autoJoin.lastEventAt).toLocaleString()}</small>}
            </li>
          );
        })}
      </ul>
      {other.length > 0 && (
        <ul className="other-problems">
          {other.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {recheck.isError && <p role="alert">Setup could not be checked. Try again shortly.</p>}
    </>
  );
}
