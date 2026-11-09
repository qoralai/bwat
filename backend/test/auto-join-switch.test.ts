import { describe, expect, it } from 'vitest';
import {
  AUTO_JOIN_KEY,
  AUTO_JOIN_REQUIRE_HOST_KEY,
  createAutoJoinSwitch,
  nothingStored,
  SETTINGS_CACHE_MAX_MS,
  switchIsOn,
} from '../src/auto-join-switch.ts';

/** A stand-in for the settings reader: `answer` for the switch (its reads counted), nothing stored for any other key. */
function fakeReader(answer: () => Promise<unknown>) {
  let reads = 0;
  const read = async (key: string) => {
    if (key !== AUTO_JOIN_KEY) return undefined;
    reads++;
    return answer();
  };
  return { read, reads: () => reads };
}

describe('the stored auto-join switch (QOR-4576)', () => {
  it('is the one catalogue key settings owns, auto_join_enabled', () => {
    expect(AUTO_JOIN_KEY).toBe('auto_join_enabled');
  });

  it('rejects explicit false and malformed values', () => {
    expect(switchIsOn(true)).toBe(true);
    for (const off of [false, 'true', 'on', 1, 0, {}, [], 'false']) {
      expect(switchIsOn(off), JSON.stringify(off)).toBe(false);
    }
  });

  it('starts off for absent and reset values', async () => {
    // Off until an admin turns it on; only an explicit true joins.
    for (const raw of [undefined, null]) {
      const sw = createAutoJoinSwitch(async (key) => (key === AUTO_JOIN_KEY ? raw : undefined), { now: () => 0 });
      expect(await sw.isOn(), String(raw)).toBe(false);
    }
    expect(switchIsOn(undefined)).toBe(false);
    expect(switchIsOn(null)).toBe(false);
    expect(await nothingStored(AUTO_JOIN_KEY)).toBeUndefined();
    expect(await createAutoJoinSwitch(nothingStored).isOn()).toBe(false);
  });
});

describe('the switch cache (QOR-4576)', () => {
  it('reads once within the cache window, and again after it', async () => {
    let clock = 0;
    const { read, reads } = fakeReader(async () => true);
    const sw = createAutoJoinSwitch(read, { ttlMs: 30_000, now: () => clock });
    expect(await sw.isOn()).toBe(true);
    clock = 29_999;
    expect(await sw.isOn()).toBe(true);
    expect(reads()).toBe(1);
    clock = 30_000;
    await sw.isOn();
    expect(reads()).toBe(2);
  });

  it('never holds a value longer than 60 seconds, whatever it is asked', async () => {
    expect(SETTINGS_CACHE_MAX_MS).toBe(60_000);
    let clock = 0;
    const { read, reads } = fakeReader(async () => true);
    const sw = createAutoJoinSwitch(read, { ttlMs: 3_600_000, now: () => clock });
    await sw.isOn();
    clock = 59_999;
    await sw.isOn();
    expect(reads()).toBe(1);
    clock = 60_000;
    await sw.isOn();
    expect(reads()).toBe(2);
  });

  it('caches an absent value too', async () => {
    const { read, reads } = fakeReader(async () => undefined);
    const sw = createAutoJoinSwitch(read, { now: () => 0 });
    expect(await sw.isOn()).toBe(false);
    expect(await sw.isOn()).toBe(false);
    expect(reads()).toBe(1);
  });

  it('never caches a failure: the next read asks again', async () => {
    let fail = true;
    const { read, reads } = fakeReader(async () => {
      if (fail) throw Object.assign(new Error('down'), { code: '57P01' });
      return true;
    });
    const sw = createAutoJoinSwitch(read, { now: () => 0 });
    await expect(sw.isOn()).rejects.toMatchObject({ code: '57P01' });
    fail = false;
    expect(await sw.isOn()).toBe(true);
    expect(reads()).toBe(2);
  });

  it('drops the cached value on invalidate (a settings write), so the next read sees the new one', async () => {
    let stored: unknown = true;
    const { read, reads } = fakeReader(async () => stored);
    const sw = createAutoJoinSwitch(read, { now: () => 0 });
    expect(await sw.isOn()).toBe(true);
    stored = false;
    expect(await sw.isOn()).toBe(true);
    sw.invalidate();
    expect(await sw.isOn()).toBe(false);
    expect(reads()).toBe(2);
  });

  it('does not keep a read that was in flight when an invalidate landed', async () => {
    let release!: () => void;
    let stored: unknown = true;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { read } = fakeReader(async () => {
      const value = stored;
      if (first) {
        first = false;
        await gate; // the old value was read; the answer is still on its way
      }
      return value;
    });
    const sw = createAutoJoinSwitch(read, { now: () => 0 });
    const slow = sw.isOn();
    stored = false;
    sw.invalidate();
    release();
    expect(await slow).toBe(true);
    expect(await sw.isOn()).toBe(false);
  });
});

describe('the stored require-host key (QOR-4576)', () => {
  it('is the second catalogue key settings owns, auto_join_require_host', () => {
    expect(AUTO_JOIN_REQUIRE_HOST_KEY).toBe('auto_join_require_host');
  });

  it('stops requiring the host only for a stored false: anything else leaves it to the env', async () => {
    for (const [value, required] of [
      [false, false],
      [true, true],
      [undefined, true],
      [null, true],
      ['false', true],
      [0, true],
    ] as const) {
      const sw = createAutoJoinSwitch(async (key) => (key === AUTO_JOIN_REQUIRE_HOST_KEY ? value : true), { now: () => 0 });
      expect(await sw.requiresHost(), JSON.stringify(value)).toBe(required);
    }
  });

  it('is cached with the switch: one invalidate drops both', async () => {
    const stored: Record<string, unknown> = { [AUTO_JOIN_KEY]: true, [AUTO_JOIN_REQUIRE_HOST_KEY]: false };
    const asked: string[] = [];
    const sw = createAutoJoinSwitch(
      async (key) => {
        asked.push(key);
        return stored[key];
      },
      { now: () => 0 },
    );
    expect(await sw.requiresHost()).toBe(false);
    expect(await sw.isOn()).toBe(true);
    expect(asked.sort()).toEqual([AUTO_JOIN_KEY, AUTO_JOIN_REQUIRE_HOST_KEY]);
    stored[AUTO_JOIN_REQUIRE_HOST_KEY] = true;
    expect(await sw.requiresHost()).toBe(false);
    sw.invalidate();
    expect(await sw.requiresHost()).toBe(true);
  });

  it('fails closed with the switch: a failed read throws and is not cached', async () => {
    let fail = true;
    const sw = createAutoJoinSwitch(
      async (key) => {
        if (fail && key === AUTO_JOIN_REQUIRE_HOST_KEY) throw Object.assign(new Error('down'), { code: '57P01' });
        return key === AUTO_JOIN_REQUIRE_HOST_KEY ? false : true;
      },
      { now: () => 0 },
    );
    await expect(sw.isOn()).rejects.toMatchObject({ code: '57P01' });
    fail = false;
    expect(await sw.requiresHost()).toBe(false);
  });
});
