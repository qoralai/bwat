import { describe, expect, it } from 'vitest';
import { jira } from '../../../src/plugins/jira/index.ts';
import { pluginSettings } from '../../../src/plugins/plugin.ts';

// QOR-4722, the jira plugin's settings since QOR-4976: the site, the project key and the account
// email, each checked and stored as the core catalogue did before.
const setting = (key: string) => pluginSettings(jira).find((s) => s.key === key)!;
const check = (key: string, value: unknown) => setting(key).check(value);

describe("the jira plugin's settings", () => {
  it('are its own three, and only the email is audited without its value', () => {
    expect(pluginSettings(jira).map((s) => [s.key, s.label, s.auditValue ?? false])).toEqual([
      ['jira_site_url', 'Jira site address', true],
      ['jira_project_key', 'Jira project key', true],
      ['jira_account_email', 'Jira account email', false],
    ]);
  });

  it('take a Jira project key only: capitals first, then capitals, digits or _', () => {
    expect(check('jira_project_key', 'ABC')).toBeNull();
    expect(check('jira_project_key', 'AB_2')).toBeNull();
    for (const bad of ['abc', 'A', '1AB', 'AB-C', 7]) expect(check('jira_project_key', bad), String(bad)).toBe('Jira project key must be a Jira project key, like ABC.');
  });

  it('take an email, trimmed', () => {
    expect(check('jira_account_email', 'ops@acme.com')).toBeNull();
    expect(setting('jira_account_email').normalise!(' ops@acme.com ')).toBe('ops@acme.com');
    for (const bad of ['ops', 'ops@acme', '@acme.com', 'a b@acme.com', 3]) {
      expect(check('jira_account_email', bad), String(bad)).toBe('Jira account email must be an email address, like ops@yourcompany.com.');
    }
  });

  it('take a site as https://<name>.atlassian.net, stored without a trailing slash', () => {
    for (const good of ['https://acme.atlassian.net', 'https://acme.atlassian.net/', ' https://acme.atlassian.net ']) {
      expect(check('jira_site_url', good), good).toBeNull();
      expect(setting('jira_site_url').normalise!(good)).toBe('https://acme.atlassian.net');
    }
  });

  it('take only an Atlassian Cloud site, with no port, path or credentials: the Jira token is sent there', () => {
    const message = "Jira site address must be your Jira site's address, like https://yourcompany.atlassian.net.";
    for (const bad of [
      'http://acme.atlassian.net',
      'acme.atlassian.net',
      'https://user:pw@acme.atlassian.net',
      'https://acme.atlassian.net/jira',
      'https://jira.example.com',
      'https://169.254.169.254',
      'https://acme.atlassian.net:8443',
      'https://atlassian.net',
      'https://acme.atlassian.net?x=1',
    ]) {
      expect(check('jira_site_url', bad), bad).toBe(message);
    }
  });
});
