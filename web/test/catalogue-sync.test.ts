import { describe, expect, it } from 'vitest';
import * as backend from '../../backend/src/settings/catalogue.ts';
import * as panel from '../admin/src/catalogue.ts';

// The admin panel carries a copy of the backend's settings catalogue (the web image builds
// from web/ alone). This keeps the two in step.
const shape = ({ key, section, label, kind, codeDefault, example }: (typeof backend.SETTINGS)[number]) => ({ key, section, label, kind, codeDefault, example });

describe("the admin panel's settings catalogue", () => {
  it('equals the backend catalogue', () => {
    expect(panel.SETTINGS.map(shape)).toEqual(backend.SETTINGS.map(shape));
    expect(panel.SECTIONS).toEqual(backend.SECTIONS);
  });
});
