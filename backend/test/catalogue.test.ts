import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARDS_KEYS, SECTIONS, SERVED_KEYS, SETTINGS, settingDef, validateSection } from '../src/settings/catalogue.ts';

describe('the settings catalogue names the product bwat (QOR-4598, D143)', () => {
  it('joins as "bwat" while display_name is unset', () => {
    expect(settingDef('display_name')?.codeDefault).toBe('bwat');
  });

  describe("the installer's bot name (BWAT_BOT_NAME)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });
    const load = async () => (await import('../src/settings/catalogue.ts')).settingDef('display_name')?.codeDefault;

    it('is the display_name default when set', async () => {
      vi.stubEnv('BWAT_BOT_NAME', '  Acme notes ');
      vi.resetModules();
      expect(await load()).toBe('Acme notes');
    });

    it('falls back to "bwat" when blank', async () => {
      vi.stubEnv('BWAT_BOT_NAME', '   ');
      vi.resetModules();
      expect(await load()).toBe('bwat');
    });
  });
});

describe('per_participant_audio (QOR-4760)', () => {
  it('is not a setting: per-participant audio is always on', () => {
    expect(settingDef('per_participant_audio')).toBeUndefined();
    expect(SERVED_KEYS).not.toContain('per_participant_audio');
  });
});

describe('joining unmuted, with no camera (QOR-4904)', () => {
  it('has no join muted or camera off setting, nor their section: bwat never speaks and has no camera', () => {
    expect(settingDef('join_muted')).toBeUndefined();
    expect(settingDef('join_video_off')).toBeUndefined();
    expect(SECTIONS).not.toContain('join_options');
  });
});

describe('served to (QOR-4769)', () => {
  it('serves the bots exactly these keys', () => {
    expect(SERVED_KEYS).toEqual([
      'wait_for_start_min', 'waiting_room_min', 'idle_leave_min', 'display_name', 'chat_posts_enabled', 'chat_agenda_enabled',
    ]);
  });

  it('serves the card service the card size and the five Jev settings, and nothing else', () => {
    expect(CARDS_KEYS).toEqual(['cards_granularity', 'jev_enabled', 'jev_model', 'jev_threshold_pct', 'jev_link_threshold_pct', 'jev_deadline_s']);
  });
});

describe('the card size', () => {
  it('is one of three named steps under Behaviour, Balanced by default', () => {
    const def = SETTINGS.find((s) => s.key === 'cards_granularity')!;
    expect([def.section, def.label, def.codeDefault]).toEqual(['behaviour', 'Card grouping', 'balanced']);
    expect(validateSection('behaviour', { cards_granularity: 'fewer' })).toEqual([]);
    expect(validateSection('behaviour', { cards_granularity: 'more' })).toEqual([]);
    expect(validateSection('behaviour', { cards_granularity: 'smaller' })).toEqual(['Card grouping must be one of fewer, balanced, more.']);
  });
});

describe('the meeting chat posts', () => {
  it('are off until an admin turns them on', () => {
    expect(['chat_posts_enabled', 'chat_agenda_enabled'].map((key) => settingDef(key)?.codeDefault)).toEqual([false, false]);
  });
});

describe('the Jev settings (QOR-4769)', () => {
  it('sit in their own section with their defaults', () => {
    expect(SETTINGS.filter((s) => s.section === 'jev').map((s) => [s.key, s.kind, s.codeDefault])).toEqual([
      ['jev_enabled', { type: 'boolean' }, true],
      ['jev_model', { type: 'name' }, 'typesafe/jev-1.13'],
      ['jev_threshold_pct', { type: 'whole', min: 5, max: 95, unit: 'percent' }, 65],
      ['jev_link_threshold_pct', { type: 'whole', min: 5, max: 95, unit: 'percent' }, 85],
      ['jev_deadline_s', { type: 'whole', min: 15, max: 600, unit: 'seconds' }, 60],
    ]);
  });

  it('take whole numbers in range only', () => {
    expect(validateSection('jev', { jev_threshold_pct: 5, jev_deadline_s: 600, jev_model: 'typesafe/jev-1.13', jev_enabled: false })).toEqual([]);
    expect(validateSection('jev', { jev_threshold_pct: 96, jev_link_threshold_pct: 4, jev_deadline_s: 14 })).toEqual([
      'Jev threshold must be a whole number from 5 to 95.',
      'Link threshold must be a whole number from 5 to 95.',
      'Card deadline must be a whole number from 15 to 600.',
    ]);
  });

  describe('BWAT_JEV', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });
    const load = async () => (await import('../src/settings/catalogue.ts')).settingDef('jev_enabled')?.codeDefault;

    it('"off" turns Jev off by default', async () => {
      vi.stubEnv('BWAT_JEV', 'off');
      vi.resetModules();
      expect(await load()).toBe(false);
    });

    it('anything else leaves it on', async () => {
      vi.stubEnv('BWAT_JEV', 'on');
      vi.resetModules();
      expect(await load()).toBe(true);
    });
  });
});
