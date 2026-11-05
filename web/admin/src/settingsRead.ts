import { getJson } from './api';
import { settingDef } from './catalogue';

/** One key, as GET /v1/console/settings returns it. value null = unset; revision null = no row. */
export type Entry = {
  value: unknown;
  default: unknown;
  revision: number | null;
  updatedAt: string | null;
};

export type AutoJoin = {
  requested: boolean;
  effective: boolean;
  ready: boolean;
  problems: string[];
  /** Advice that leaves every check passing; an older backend sends none. */
  notices?: string[];
  lastEventAt: string | null;
};

export type SettingsRead = {
  settingsVersion: number;
  canManage: boolean;
  settings: Record<string, Entry>;
  /** Owners and admins only. */
  autoJoin?: AutoJoin;
};

/**
 * The settings, read once per visit under ['settings'] (ONCE): a refetch would move the
 * revision under an edit. A save invalidates it, so the next page to open reads it again.
 */
export const fetchSettings = () => getJson<SettingsRead>('/v1/console/settings');

/** What a key holds: its stored value, else the install's default, else the code's. */
export const settingAt = (read: SettingsRead | undefined, key: string): unknown =>
  read?.settings[key]?.value ?? read?.settings[key]?.default ?? settingDef(key)!.codeDefault;

/**
 * How bwat joins, in one sentence. An owner's or admin's read says whether automatic joining
 * works now; a member's says only whether it is switched on.
 */
export function joinSentence(read: SettingsRead | undefined): string {
  const on = read?.autoJoin ? read.autoJoin.effective : Boolean(settingAt(read, 'auto_join_enabled'));
  if (!on) return 'bwat joins only when invited.';
  return `bwat joins meetings in your Zoom account on its own${settingAt(read, 'auto_join_require_host') ? ', once the host is there' : ''}.`;
}
