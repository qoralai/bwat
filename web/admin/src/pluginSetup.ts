import type { ComponentType } from 'react';
import { JiraSetup } from '../../plugins/jira/admin/Setup';

/**
 * Each plugin's own setup card on the Plugins page, by plugin name: shown under the
 * plugin to an owner or admin while it is on. A card lives in the plugin's folder
 * (web/plugins/<name>/admin/) and may use the panel's core (api.ts, styles.css); this registry,
 * one import line each, is the only admin file that imports a plugin's folder.
 */
export const PLUGIN_SETUP: Readonly<Record<string, ComponentType>> = { jira: JiraSetup };
