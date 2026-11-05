import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The clone's root: every path the onboarding server reads or writes is under it. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
