import { describe, expect, it } from 'vitest';
import { fleetConfig } from '../src/config.ts';

const NAMED = { BWAT_FLEET_CLUSTER: 'bwat', BWAT_FLEET_SERVICE: 'bwat-bot' };

describe('fleet configuration (QOR-4888)', () => {
  it('is off when unset or empty, and then needs nothing else', () => {
    expect(fleetConfig({}).mode).toBe('off');
    expect(fleetConfig({ BWAT_FLEET_AUTOSCALE: '' }).mode).toBe('off');
    expect(fleetConfig({ BWAT_FLEET_AUTOSCALE: 'off' }).mode).toBe('off');
  });

  it('defaults to min 1, max 2, headroom 1', () => {
    expect(fleetConfig({ BWAT_FLEET_AUTOSCALE: 'dryrun', ...NAMED })).toEqual({
      mode: 'dryrun',
      min: 1,
      max: 2,
      headroom: 1,
      cluster: 'bwat',
      service: 'bwat-bot',
    });
  });

  it('reads every knob', () => {
    expect(
      fleetConfig({ BWAT_FLEET_AUTOSCALE: 'on', ...NAMED, BWAT_FLEET_MIN: '0', BWAT_FLEET_MAX: '4', BWAT_FLEET_HEADROOM: '2' }),
    ).toMatchObject({ mode: 'on', min: 0, max: 4, headroom: 2 });
  });

  it('refuses a mode it does not know rather than guess at one that writes to ECS', () => {
    expect(() => fleetConfig({ BWAT_FLEET_AUTOSCALE: 'protect', ...NAMED })).toThrow(
      'BWAT_FLEET_AUTOSCALE must be off, dryrun or on',
    );
  });

  it('refuses dryrun or on without the cluster and the service it sizes', () => {
    for (const mode of ['dryrun', 'on']) {
      expect(() => fleetConfig({ BWAT_FLEET_AUTOSCALE: mode, BWAT_FLEET_SERVICE: 's' })).toThrow('BWAT_FLEET_CLUSTER is not set');
      expect(() => fleetConfig({ BWAT_FLEET_AUTOSCALE: mode, BWAT_FLEET_CLUSTER: 'c' })).toThrow('BWAT_FLEET_SERVICE is not set');
    }
  });

  it('refuses a max above 10, the most tasks one protection call takes', () => {
    expect(fleetConfig({ BWAT_FLEET_AUTOSCALE: 'on', ...NAMED, BWAT_FLEET_MAX: '10' }).max).toBe(10);
    expect(() => fleetConfig({ BWAT_FLEET_AUTOSCALE: 'on', ...NAMED, BWAT_FLEET_MAX: '11' })).toThrow('BWAT_FLEET_MAX must be at most 10');
  });

  it('refuses a bound that is not a whole number', () => {
    expect(() => fleetConfig({ BWAT_FLEET_AUTOSCALE: 'on', ...NAMED, BWAT_FLEET_MAX: 'two' })).toThrow(
      'BWAT_FLEET_MAX must be a whole number',
    );
  });
});
