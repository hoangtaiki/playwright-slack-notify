import { test, expect } from './support/slack-server.js';
import { notify } from '../src/notify.js';
import type { RunSummary } from '../src/model.js';

// notify.ts's shouldNotify() gate is private; exercised here through
// notify()'s public behaviour (whether a request reaches the server at all),
// which is the thing that actually matters.
const base: RunSummary = {
  outcome: 'passed',
  passed: 5,
  failed: 0,
  flaky: 0,
  skipped: 0,
  failures: [],
};

test.describe('notify - the silence gate', () => {
  test('a clean pass with sendResults: on-failure (default) stays silent', async ({
    slack,
  }) => {
    const result = await notify(base, { webhookUrl: slack.url });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('nothing-to-report');
    expect(slack.requests).toHaveLength(0);
  });

  test('sendResults: "always" posts even on a clean pass', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await notify(
      base,
      { webhookUrl: slack.url },
      { sendResults: 'always' }
    );
    expect(result.ok).toBe(true);
    expect(slack.requests).toHaveLength(1);
  });

  test('sendResults: "off" never posts, even with real failures', async ({
    slack,
  }) => {
    const result = await notify(
      {
        ...base,
        outcome: 'failed',
        failed: 3,
        failures: [{ title: 'a > b' }, { title: 'a > c' }, { title: 'a > d' }],
      },
      { webhookUrl: slack.url },
      { sendResults: 'off' }
    );
    expect(result.skipped).toBe(true);
    expect(slack.requests).toHaveLength(0);
  });

  test('failed > 0 posts under the default on-failure mode', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await notify(
      { ...base, outcome: 'failed', failed: 1, failures: [{ title: 'a > b' }] },
      { webhookUrl: slack.url }
    );
    expect(result.ok).toBe(true);
    expect(slack.requests).toHaveLength(1);
  });

  test('a flaky-only run posts by default (notifyOnFlaky defaults true)', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await notify(
      { ...base, flaky: 1, flakyTests: [{ title: 'a > b', status: 'flaky' }] },
      { webhookUrl: slack.url }
    );
    expect(result.ok).toBe(true);
    expect(slack.requests).toHaveLength(1);
  });

  test('notifyOnFlaky: false silences a flaky-only run', async ({ slack }) => {
    const result = await notify(
      { ...base, flaky: 1, flakyTests: [{ title: 'a > b', status: 'flaky' }] },
      { webhookUrl: slack.url },
      { notifyOnFlaky: false }
    );
    expect(result.skipped).toBe(true);
    expect(slack.requests).toHaveLength(0);
  });

  test('report errors alone (zero failed tests) still post - the case playwright-report-analyzer exists to catch', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await notify(
      {
        ...base,
        outcome: 'failed',
        reportErrors: [{ message: 'Cannot find module' }],
      },
      { webhookUrl: slack.url }
    );
    expect(result.ok).toBe(true);
    expect(slack.requests).toHaveLength(1);
  });

  test("an outcome that isn't 'passed', with nothing else wrong, still posts", async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await notify(
      { ...base, outcome: 'interrupted' },
      { webhookUrl: slack.url }
    );
    expect(result.ok).toBe(true);
    expect(slack.requests).toHaveLength(1);
  });
});
