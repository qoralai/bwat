import { goals } from '../../../plugins/goals/index.ts';
import { jira } from '../../../plugins/jira/index.ts';
import type { WebPlugin } from './plugin.ts';

/**
 * Every web plugin bwat ships, one import line each: the web sides of the backend's plugins
 * (web/plugins/<name>/). The only core file that may import a plugin's folder (eslint.config.js).
 * Which of them run is the backend's to say (./activation.ts).
 */
export const WEB_PLUGINS: readonly WebPlugin[] = [goals, jira];
