import { expect, it } from 'vitest';
import { start } from '../../../src/server.ts';
import { describeDb, useTestDb } from '../../db/harness.ts';
import { FakeSecretsManager } from '../../fake-secrets-manager.ts';

const DEV = 'd'.repeat(40);

// QOR-4976: the jira plugin's start step runs at every server start, on or off, through the
// secret store start() makes, which keeps the plugin's retired jira.email.
describeDb("the jira plugin's start step", () => {
  const db = useTestDb();
  const env = (extra: NodeJS.ProcessEnv) => ({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_DEV_PERSON_TOKEN: DEV, ...extra });

  it('moves a Jira account email stored as a secret into its setting as the server starts, the plugin off, and deletes the secret', async () => {
    const fake = new FakeSecretsManager();
    fake.secrets.set('bwat/test/jira.email', { value: 'ops@acme.com', scheduled: false });
    const app = await start(env({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/' }), { awsClient: fake });
    try {
      const { port } = app.server.address() as { port: number };
      const read = await (await fetch(`http://127.0.0.1:${port}/v1/console/plugins/jira/settings`, { headers: { authorization: `Bearer ${DEV}` } })).json();
      expect(read.settings.jira_account_email.value).toBe('ops@acme.com');
      expect(fake.calls).toContain('DeleteSecretCommand');
    } finally {
      await app.close();
    }
  });
});
