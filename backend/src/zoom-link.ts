interface ZoomMeeting {
  /** 9 to 12 digits. */
  meetingNumber: string;
  /** The link's `pwd` parameter, if any. Meeting content: never logged. */
  passcode: string | null;
}

/**
 * A Zoom join link (`https://<zoom.us or a subdomain>/j/<9-12 digits>[?pwd=...]`, the
 * scheme optional) as a meeting number and passcode; null for anything else. The host
 * is compared as a parsed hostname, so look-alikes such as `zoom.us.evil.com` fail, and
 * a passcode holding a control character (such as NUL) fails too.
 */
export function parseZoomLink(link: string): ZoomMeeting | null {
  const text = link.trim();
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'zoom.us' && !url.hostname.endsWith('.zoom.us')) return null;
  const meetingNumber = /^\/j\/(\d{9,12})$/.exec(url.pathname)?.[1];
  if (!meetingNumber) return null;
  const passcode = url.searchParams.get('pwd');
  // No Zoom passcode holds a control character; a NUL would also break the jsonb briefing.
  if (passcode !== null && /[\u0000-\u001f\u007f]/.test(passcode)) return null;
  return { meetingNumber, passcode };
}
