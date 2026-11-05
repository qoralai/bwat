/**
 * Runs `step` `firstMs` from now (default `ms`), then `ms` after the last run settled, never two at once: a slow run (a database
 * under load) delays the next one instead of stacking runs on the pool. `step` handles
 * its own errors; one that escapes is dropped, so it cannot end the schedule. stop() schedules nothing more and resolves once a run in flight has finished,
 * so the pool can be ended behind it. The timer never keeps the process alive.
 */
export function repeat(step: () => Promise<void>, ms: number, firstMs = ms): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = (wait: number) => {
    timer = setTimeout(() => {
      running = step()
        .catch(() => undefined)
        .then(() => {
          running = undefined;
          if (!stopped) schedule(ms);
        });
    }, wait);
    timer.unref();
  };
  schedule(firstMs);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
