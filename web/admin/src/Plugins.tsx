import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { andList, getJson, ONCE, sendJsonForBody } from './api';
import { LoadError } from './LoadError';
import { PLUGIN_SETUP } from './pluginSetup';

/* The plugins bwat ships, each switched on or off by an owner or admin; a member reads which
   are on. A switch saves at once and the backend applies it with no restart. */

type Plugin = {
  name: string;
  display_name: string;
  description: string;
  on: boolean;
  /** What the operator must set first, or null. */
  needs: { env: string; to: string } | null;
};
type PluginsRead = { canManage: boolean; plugins: Plugin[] };

const fetchPlugins = () => getJson<PluginsRead>('/v1/console/plugins');

/** One plugin, as an owner or admin sees it. */
function Row({ plugin }: { plugin: Plugin }) {
  const queryClient = useQueryClient();
  // What it holds, while the inline check before turning it off is shown.
  const [confirming, setConfirming] = useState<string | null>(null);
  // The switch is disabled while a change is on its way, which drops its focus: it gets it
  // back once the change, or the check, is done.
  const toggle = useRef<HTMLInputElement>(null);
  const [refocus, setRefocus] = useState(false);
  // Turning off first asks what it holds; when it holds something, the check is shown instead.
  const turn = useMutation({
    mutationFn: async ({ on, confirmed = false }: { on: boolean; confirmed?: boolean }) => {
      if (!on && !confirmed) {
        const { holds } = await getJson<{ holds: string | null }>(`/v1/console/plugins/${plugin.name}/holds`);
        if (holds) return { holds };
      }
      return { saved: await sendJsonForBody('PUT', `/v1/console/plugins/${plugin.name}`, { on }) };
    },
    onSuccess: (result) => {
      if (result.holds) return setConfirming(result.holds);
      setConfirming(null);
      setRefocus(true);
      queryClient.setQueryData(['plugins'], result.saved);
    },
  });
  useEffect(() => {
    if (!refocus || turn.isPending) return;
    setRefocus(false);
    toggle.current?.focus();
  }, [refocus, turn.isPending]);
  const id = `plugin-${plugin.name}`;
  const Setup = plugin.on ? PLUGIN_SETUP[plugin.name] : undefined;
  const [state, label] = plugin.needs ? ['stale', 'Needs setup'] : plugin.on ? ['attending', 'On'] : ['idle', 'Off'];
  return (
    <div className="plugin">
      <span className="name">
        {plugin.display_name} <span className={`pill ${state}`}>{label}</span>
      </span>
      <span className="switch">
        <input
          ref={toggle}
          id={id}
          type="checkbox"
          role="switch"
          aria-label={plugin.display_name}
          aria-describedby={plugin.needs ? `${id}-about ${id}-help` : `${id}-about`}
          checked={plugin.on}
          disabled={plugin.needs !== null || turn.isPending}
          onChange={() => turn.mutate({ on: !plugin.on })}
        />
        <i aria-hidden="true" />
      </span>
      <p className="muted" id={`${id}-about`}>
        {plugin.description}
      </p>
      {plugin.needs && (
        <p className="help" id={`${id}-help`}>
          Your server&apos;s operator needs to {plugin.needs.to} (<code>{plugin.needs.env}</code>). The switch works once that&apos;s set.
        </p>
      )}
      {confirming && (
        <div className="notice warn confirm" role="group" aria-label={`Turn off ${plugin.display_name}`} aria-describedby={`${id}-check`}>
          <span id={`${id}-check`}>{`Turn off ${plugin.display_name}? Its ${confirming} disappear from the board until you turn it back on. Nothing is deleted.`}</span>
          {/* Focus moves into the check: it has just appeared in answer to the switch. */}
          <button type="button" className="button" autoFocus onClick={() => { setConfirming(null); setRefocus(true); }}>
            Keep it on
          </button>
          <button type="button" className="button primary" disabled={turn.isPending} onClick={() => turn.mutate({ on: false, confirmed: true })}>
            Turn off
          </button>
        </div>
      )}
      {Setup && (
        <div className="setup">
          <Setup />
        </div>
      )}
      {turn.isError && (
        <p role="alert" className="error">
          Nothing changed. Try again.
        </p>
      )}
    </div>
  );
}

export function Plugins() {
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: fetchPlugins, ...ONCE });
  const read = plugins.error ? undefined : plugins.data;
  return (
    <section className="plugins">
      <h2>Plugins</h2>
      {plugins.isPending && (
        <p role="status" className="muted">
          Loading plugins…
        </p>
      )}
      <LoadError what="the plugins" error={plugins.error} />
      {read &&
        (read.canManage ? (
          <>
            <p className="muted sub">
              Extra features for your team. Turning one off hides it everywhere and keeps its data, so turning it back on brings everything back.
            </p>
            {read.plugins.map((p) => (
              <Row key={p.name} plugin={p} />
            ))}
          </>
        ) : (
          <>
            <div className="readonly">
              {[true, false].map((on) => {
                const names = read.plugins.filter((p) => p.on === on).map((p) => p.display_name);
                return names.length > 0 && <p key={String(on)}>{`${andList(names)} ${names.length > 1 ? 'are' : 'is'} ${on ? 'on' : 'off'}.`}</p>;
              })}
            </div>
            <p className="muted">Only an owner or an admin changes these.</p>
          </>
        ))}
    </section>
  );
}
