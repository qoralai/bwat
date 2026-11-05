import type { WebPlugin } from '../../server/src/plugins/plugin.ts';

/** The jira plugin's web side: its board script (README.md). On while the backend runs the jira plugin. */
export const jira: WebPlugin = {
  name: 'jira',
  boardScripts: ['board.js'],
};
