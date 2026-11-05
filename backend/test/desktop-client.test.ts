import { expect, it } from 'vitest';
import { describeDb } from './db/harness.ts';
import { useApp } from './app.ts';

// Nobody is signed in: the route must answer anyway.
const nobody = async () => null;

describeDb('the plugin gets the Google Desktop client to sign in with from bwat (QOR-4713)', () => {
  const t = useApp({ authenticatePerson: nobody, desktopClient: { id: '2-desktop.apps.googleusercontent.com', secret: 'desktop-secret' } });

  it('answers the Desktop client id and secret to anyone: an installed app cannot keep a secret anyway', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/desktop-client' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ client_id: '2-desktop.apps.googleusercontent.com', client_secret: 'desktop-secret', code_signin: false });
    // Never kept by a proxy or CDN in front of the install.
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describeDb('an install without a Desktop client says so (QOR-4713)', () => {
  const t = useApp({ authenticatePerson: nobody });

  it('answers nulls, so the plugin can say the install has none', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/desktop-client' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ client_id: null, client_secret: null, code_signin: false });
  });
});
