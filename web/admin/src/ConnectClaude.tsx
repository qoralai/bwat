import { useEffect, useRef } from 'react';

// The marketplace that lists the bwat plugin: the public marketplace.
// web/test/claude-connect.test.ts keeps this, setup's and the docs' equal.
const MARKETPLACE_REPO = 'qoralai/qoral-plugin-marketplace';
const MARKETPLACE = 'qoral-plugin-marketplace';

/**
 * The terminal commands that install the plugin pointed at this bwat; run again, they change its
 * address. The plugin takes plain http only for the 127.0.0.1 literal, not the name localhost.
 */
function claudeCommands(origin: string): string {
  const url = new URL(origin);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return `claude plugin marketplace add ${MARKETPLACE_REPO}\nclaude plugin install bwat@${MARKETPLACE} --config base_url=${url.origin}/v1`;
}

/**
 * Opened as #/members?claude (the old #/?claude still lands here), the page scrolls to these
 * commands once the member list above has loaded.
 */
export function ConnectClaude({ ready }: { ready: boolean }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ready && new URLSearchParams(window.location.hash.split('?')[1] ?? '').has('claude')) box.current?.scrollIntoView({ block: 'start' });
  }, [ready]);
  return (
    <section ref={box} className="invite" aria-labelledby="connect-claude-heading">
      <h3 id="connect-claude-heading">Connect Claude Code</h3>
      <p className="muted">
        Share these with teammates. Each runs them in a terminal, restarts Claude Code, then types /bwat:login.
      </p>
      <pre className="commands">{claudeCommands(window.location.origin)}</pre>
    </section>
  );
}
