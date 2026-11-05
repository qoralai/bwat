import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiError, fetchWhoami, isAdmin, nameOf, rememberBearer, type Whoami } from './api';
import { Members } from './Members';
import { Overview } from './Overview';
import { Settings } from './Settings';
import { Plugins } from './Plugins';
import { SetupPill } from './FinishSetup';

// The sign-in server keeps the session in an HttpOnly cookie; the page holds only the
// person's own id_token, from /whoami, as its bearer to the backend (D180).

type MeState = { kind: 'signed_out' } | { kind: 'not_configured' } | { kind: 'me'; me: Whoami };

// 401 and 503 are states, not errors, so react-query never retries them.
async function fetchMe(): Promise<MeState> {
  const res = await fetchWhoami();
  if (res.status === 503) return { kind: 'not_configured' };
  if (res.status === 401) return { kind: 'signed_out' };
  if (!res.ok) throw await apiError(res);
  const me = (await res.json()) as Whoami;
  rememberBearer(me);
  return { kind: 'me', me };
}

function Card({ children }: { children: ReactNode }) {
  return (
    <main className="center">
      <section className="card">
        <h1 className="brand">bwat admin</h1>
        {children}
      </section>
    </main>
  );
}

function SignedOut() {
  return (
    <>
      <p className="lead">Manage bwat for your company.</p>
      <a className="button primary" href="/auth/login">
        Sign in
      </a>
    </>
  );
}

// The shell's pages, by hash: the server serves one index.html at /admin/.
const pages = [
  { path: '/', label: 'Overview', render: (canManage: boolean) => <Overview isAdmin={canManage} /> },
  { path: '/members', label: 'Members', render: (canManage: boolean) => <Members canManage={canManage} /> },
  { path: '/settings', label: 'Settings', render: () => <Settings /> },
  { path: '/plugins', label: 'Plugins', render: () => <Plugins /> },
] as const;
type PagePath = (typeof pages)[number]['path'];

/**
 * Where an old link now goes: Status and History are on the Overview, the Dictionary is
 * under Settings, Cards, and the board's #/?claude names the Connect Claude Code box, on Members.
 */
function movedTo(hash: string): string | null {
  const [path, query] = hash.split('?');
  if (path === '#/status' || path === '#/history') return '#/';
  if (path === '#/dictionary') return '#/settings?place=cards';
  if ((path === '#/' || path === '' || path === '#') && new URLSearchParams(query ?? '').has('claude')) return '#/members?claude';
  return null;
}

/** The page a hash shows, after moving an old link to its new home. A page may carry a query after its path. */
function pageAt(): PagePath {
  const moved = movedTo(window.location.hash);
  if (moved) window.history.replaceState(null, '', moved);
  return pages.find((p) => `#${p.path}` === window.location.hash.split('?')[0])?.path ?? '/';
}

function Shell({ me }: { me: Whoami }) {
  const [page, setPage] = useState(pageAt);
  // Back and Forward change the hash without a click here.
  useEffect(() => {
    const onHashChange = () => setPage(pageAt());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return (
    <>
      <header className="topbar">
        <div className="title">
          <h1 className="brand">bwat admin</h1>
        </div>
        <div className="account">
          <p className="person">
            <span className="name">{nameOf(me.member)}</span>
            <span className="email">{me.member.email}</span>
          </p>
          <a className="button" href="/auth/logout">
            Sign out
          </a>
        </div>
      </header>
      <nav className="sections" aria-label="Sections">
        {pages.map(({ path, label }) => (
          <a key={path} href={`#${path}`} aria-current={page === path ? 'page' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <main className="content">
        {isAdmin(me.member) && page !== '/' && <SetupPill />}
        {pages.find((p) => p.path === page)!.render(isAdmin(me.member))}
      </main>
    </>
  );
}

export function App() {
  // Retried as React Query does by default: a 401 or 503 is an answer, not an error.
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: 3 });
  const state = me.data;

  if (state?.kind === 'me') return <Shell me={state.me} />;

  return (
    <Card>
      {me.isPending && (
        <p role="status" className="muted">
          Loading your account…
        </p>
      )}
      {me.isError && (
        <p role="alert" className="error">
          We couldn&apos;t load your account. Reload the page to try again.
        </p>
      )}
      {state?.kind === 'signed_out' && <SignedOut />}
      {state?.kind === 'not_configured' && (
        <p role="alert" className="error">
          Sign-in isn&apos;t set up for this install yet.
        </p>
      )}
    </Card>
  );
}
