import { goals } from './goals/index.ts';
import { jira } from './jira/index.ts';
import type { BwatPlugin } from './plugin.ts';

/**
 * Every plugin bwat ships, one import line each (QOR-4806). The only core file that may
 * import a plugin's folder (eslint.config.js). Which of them run is an admin's switch on the
 * panel's Plugins page (switches.ts).
 */
export const PLUGINS: readonly BwatPlugin[] = [goals, jira];
