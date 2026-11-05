import { sessionGone } from './api';

/** A page's read that failed, said once; a session that ended is /whoami's to show, not this. */
export function LoadError({ what, error }: { what: string; error: Error | null }) {
  if (!error || sessionGone(error)) return null;
  return (
    <p role="alert" className="error">
      We couldn&apos;t load {what}. Reload the page to try again.
    </p>
  );
}
