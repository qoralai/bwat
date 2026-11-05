import { describe, expect, it } from 'vitest';
import { parseZoomLink } from '../src/zoom-link.ts';

describe('parseZoomLink (QOR-4571)', () => {
  it('reads the meeting number and passcode from a Zoom join link', () => {
    expect(parseZoomLink('https://zoom.us/j/123456789')).toEqual({ meetingNumber: '123456789', passcode: null });
    expect(parseZoomLink('https://us02web.zoom.us/j/81234567890?pwd=abc.1')).toEqual({
      meetingNumber: '81234567890',
      passcode: 'abc.1',
    });
    expect(parseZoomLink('  https://acme.zoom.us/j/123456789012  ')).toEqual({
      meetingNumber: '123456789012',
      passcode: null,
    });
    expect(parseZoomLink('zoom.us/j/123456789')).toEqual({ meetingNumber: '123456789', passcode: null });
  });

  it('refuses a meeting number outside 9-12 digits', () => {
    expect(parseZoomLink('https://zoom.us/j/12345678')).toBeNull();
    expect(parseZoomLink('https://zoom.us/j/1234567890123')).toBeNull();
  });

  it('refuses hosts that only look like Zoom', () => {
    for (const link of [
      'https://zoom.us.evil.com/j/123456789',
      'https://notzoom.us/j/123456789',
      'https://evil.com/zoom.us/j/123456789',
      'https://evil.com/?u=https://zoom.us/j/123456789',
      'https://zoom.us@evil.com/j/123456789',
    ]) {
      expect(parseZoomLink(link), link).toBeNull();
    }
  });

  it('refuses anything that is not an http(s) link to a meeting', () => {
    for (const link of [
      'javascript://zoom.us/j/123456789',
      'ftp://zoom.us/j/123456789',
      'https://zoom.us/my/someone',
      'https://zoom.us/j/123456789/extra',
      'https://zoom.us/j/12345abc9',
      'https://zoom.us/',
      '123456789',
      '',
      'not a link',
    ]) {
      expect(parseZoomLink(link), link).toBeNull();
    }
  });

  it('refuses a passcode holding a control character, such as NUL (QOR-4571 review)', () => {
    for (const pwd of ['abc%00', '%00', 'a%0Ab', 'a%09b', 'a%1Fb', 'a%7Fb']) {
      expect(parseZoomLink(`https://zoom.us/j/84949765022?pwd=${pwd}`), pwd).toBeNull();
    }
    expect(parseZoomLink('https://zoom.us/j/84949765022?pwd=ok%2Bfine')).toEqual({
      meetingNumber: '84949765022',
      passcode: 'ok+fine',
    });
  });
});
