import type { WebPlugin } from '../../server/src/plugins/plugin.ts';

/** The goals plugin's web side: its board script only (README.md). On while the backend runs the goals plugin. */
export const goals: WebPlugin = {
  name: 'goals',
  boardScripts: ['board.js'],
};
