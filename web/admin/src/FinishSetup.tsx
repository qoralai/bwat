import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, sendJson } from './api';

// The onboarding page's steps that were still open when its installer
// stopped (setup/onboard), for an owner or admin to tick off by hand. Shown on the Overview
// while any is open, and counted in a pill on the other pages; nothing at all when the list
// is empty or cannot be read.

type Item = { id: string; title: string; detail: string; link: string | null; done_at: string | null };

function useOpenSteps(): Item[] {
  const list = useQuery({
    queryKey: ['setup-checklist'],
    queryFn: () => getJson<{ items: Item[] }>('/v1/setup-checklist'),
  });
  return (list.data?.items ?? []).filter((item) => !item.done_at);
}

/** Elsewhere than the Overview: how many steps are open, linking to them. */
export function SetupPill() {
  const open = useOpenSteps().length;
  if (!open) return null;
  return (
    <a className="pill warn setup-pill" href="#/">
      {open === 1 ? '1 setup step open' : `${open} setup steps open`}
    </a>
  );
}

export function FinishSetup() {
  const queryClient = useQueryClient();
  const open = useOpenSteps();
  const done = useMutation({
    mutationFn: (id: string) => sendJson('POST', `/v1/setup-checklist/${encodeURIComponent(id)}/done`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-checklist'] }),
  });
  if (!open.length) return null;
  return (
    <section className="settings-section finish-setup" aria-labelledby="finish-setup">
      <h2 id="finish-setup">Finish setting up</h2>
      <p className="muted">
        These steps were still open when bwat&apos;s setup page last saw them. Tick each one off once it is done.
      </p>
      <ul className="finish-setup-list">
        {open.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.title}</strong>
              {item.detail && <p className="muted">{item.detail}</p>}
              {item.link && (
                <a href={item.link} target="_blank" rel="noopener noreferrer">
                  How to do it
                </a>
              )}
            </div>
            <button type="button" className="button" disabled={done.isPending} onClick={() => done.mutate(item.id)}>
              Done
            </button>
          </li>
        ))}
      </ul>
      {done.isError && (
        <p role="alert" className="error">
          We couldn&apos;t save that. Try again.
        </p>
      )}
    </section>
  );
}
