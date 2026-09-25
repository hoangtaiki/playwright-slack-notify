import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from '@playwright/test';
import {
  send,
  type BotTokenTransport,
  type WebhookTransport,
} from '../src/send.js';
import type { SlackMessage } from '../src/blocks.js';
import { test } from './support/slack-server.js';
import { assertNoSecret } from './support/leak.js';

const MESSAGE: SlackMessage = { text: 'hello', blocks: [] };

function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

test.describe('send - webhook success and failure', () => {
  test('a 200 "ok" response is a success on the first attempt, with the real content-type header sent', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await send(MESSAGE, { webhookUrl: slack.url });
    expect(result).toEqual({
      ok: true,
      status: 200,
      attempts: 1,
      retryable: false,
      durationMs: expect.any(Number),
    });
    expect(slack.requests).toHaveLength(1);
    expect(slack.requests[0].headers['content-type']).toBe('application/json');
    expect(slack.requests[0].headers.authorization).toBeUndefined();
    expect(slack.requests[0].body).toEqual({
      text: 'hello',
      blocks: [],
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test('a 400 invalid_payload is not retried and is surfaced verbatim', async ({
    slack,
  }) => {
    slack.respondWith({ status: 400, body: 'invalid_payload' });
    const result = await send(MESSAGE, { webhookUrl: slack.url });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_payload');
    expect(result.code).toBe('http_error');
    expect(result.retryable).toBe(false);
    expect(slack.requests).toHaveLength(1);
  });

  test('every documented webhook error string is surfaced verbatim and treated as non-retryable', async ({
    slack,
  }) => {
    const errors = [
      'channel_not_found',
      'no_service',
      'no_text',
      'channel_is_archived',
      'team_disabled',
      'action_prohibited',
      'posting_to_general_channel_denied',
      'invalid_token',
      'no_active_hooks',
    ];
    for (const error of errors) {
      slack.reset();
      slack.respondWith({ status: 400, body: error });
      const result = await send(MESSAGE, { webhookUrl: slack.url });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(error);
      expect(result.retryable).toBe(false);
    }
  });

  test('a 5xx is retried and eventually succeeds', async ({ slack }) => {
    slack.respondWith(
      { status: 503, body: 'service_unavailable' },
      { status: 200, body: 'ok' }
    );
    const { sleep } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep }
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(slack.requests).toHaveLength(2);
  });

  test('a 5xx that never recovers exhausts retries and reports the last error', async ({
    slack,
  }) => {
    slack.respondWith({ status: 503, body: 'service_unavailable' });
    const { sleep } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { maxRetries: 2, _sleep: sleep }
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.retryable).toBe(true);
  });
});

test.describe('send - rate limiting (429 + Retry-After)', () => {
  test('an integer-seconds Retry-After is honoured exactly', async ({
    slack,
  }) => {
    slack.respondWith(
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, body: 'ok' }
    );
    const { sleep, delays } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep }
    );
    expect(result.ok).toBe(true);
    expect(delays).toEqual([1000]);
  });

  test('Retry-After: 0 is honoured as an immediate retry', async ({
    slack,
  }) => {
    slack.respondWith(
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: 'ok' }
    );
    const { sleep, delays } = recordingSleep();
    await send(MESSAGE, { webhookUrl: slack.url }, { _sleep: sleep });
    expect(delays).toEqual([0]);
  });

  test('a huge Retry-After is clamped to maxDelayMs, never left to sleep for real', async ({
    slack,
  }) => {
    slack.respondWith(
      { status: 429, headers: { 'retry-after': '3600' } },
      { status: 200, body: 'ok' }
    );
    const { sleep, delays } = recordingSleep();
    await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep, maxDelayMs: 30_000 }
    );
    expect(delays).toEqual([30_000]);
  });

  test('a non-numeric Retry-After (HTTP-date form) falls back to our own backoff, not a crash', async ({
    slack,
  }) => {
    slack.respondWith(
      {
        status: 429,
        headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      },
      { status: 200, body: 'ok' }
    );
    const { sleep, delays } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep, _random: () => 0 }
    );
    expect(result.ok).toBe(true);
    expect(delays).toEqual([250]); // equal-jitter backoff, attempt 0, random()=0 -> base/2
  });

  test('garbage Retry-After also falls back to backoff', async ({ slack }) => {
    slack.respondWith(
      { status: 429, headers: { 'retry-after': 'abc' } },
      { status: 200, body: 'ok' }
    );
    const { sleep, delays } = recordingSleep();
    await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep, _random: () => 0 }
    );
    expect(delays).toEqual([250]);
  });

  test('an absent Retry-After also falls back to backoff', async ({
    slack,
  }) => {
    slack.respondWith({ status: 429 }, { status: 200, body: 'ok' });
    const { sleep, delays } = recordingSleep();
    await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep, _random: () => 0 }
    );
    expect(delays).toEqual([250]);
  });

  test('exhausting retries on a persistent 429 reports rate_limited with the clamped delay', async ({
    slack,
  }) => {
    slack.respondWith({ status: 429, headers: { 'retry-after': '5' } });
    const { sleep } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { maxRetries: 1, _sleep: sleep }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.code).toBe('rate_limited');
    expect(result.retryAfterMs).toBe(5000);
  });
});

test.describe('send - equal jitter backoff formula', () => {
  test('delay is always within [base/2, base] across many random draws', async ({
    slack,
  }) => {
    slack.respondWith(
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 200, body: 'ok' }
    );
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { maxRetries: 3, _sleep: sleep, _random: Math.random }
    );
    // base for attempt i is min(500 * 2**i, 30000): 500, 1000, 2000.
    const bases = [500, 1000, 2000];
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(bases[i] / 2);
      expect(d).toBeLessThanOrEqual(bases[i]);
    });
  });

  test('exact delays with a deterministic random source', async ({ slack }) => {
    slack.respondWith({ status: 503 }, { status: 200, body: 'ok' });
    const { sleep, delays } = recordingSleep();
    await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { _sleep: sleep, _random: () => 0.5 }
    );
    // base = 500, delay = 250 + 0.5*250 = 375
    expect(delays).toEqual([375]);
  });
});

test.describe('send - timeout', () => {
  test('a response slower than timeoutMs is treated as a timeout and retried', async ({
    slack,
  }) => {
    slack.respondWith(
      { delayMs: 300, status: 200, body: 'ok' },
      { status: 200, body: 'ok' }
    );
    const { sleep } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { timeoutMs: 50, _sleep: sleep }
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  test('a persistent timeout exhausts retries and reports code: timeout', async ({
    slack,
  }) => {
    slack.respondWith({ delayMs: 300, status: 200, body: 'ok' });
    const { sleep } = recordingSleep();
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { timeoutMs: 50, maxRetries: 1, _sleep: sleep }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('timeout');
    expect(result.attempts).toBe(2);
  });
});

test.describe('send - dry run', () => {
  test('dry run never makes a request and returns the exact payload', async ({
    slack,
  }) => {
    const result = await send(
      MESSAGE,
      {
        webhookUrl: slack.url,
        channel: '#test',
        username: 'Bot',
        iconEmoji: ':robot_face:',
      },
      { dryRun: true }
    );
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.attempts).toBe(0);
    expect(slack.requests).toHaveLength(0);
    expect(result.payload).toEqual({
      text: 'hello',
      blocks: [],
      unfurl_links: false,
      unfurl_media: false,
      channel: '#test',
      username: 'Bot',
      icon_emoji: ':robot_face:',
    });
  });

  test('render: "text" omits blocks from the payload', async ({ slack }) => {
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { dryRun: true, render: 'text' }
    );
    expect(result.payload).not.toHaveProperty('blocks');
    expect(result.payload?.text).toBe('hello');
  });

  test('unfurlLinks/unfurlMedia are reflected in the payload', async ({
    slack,
  }) => {
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { dryRun: true, unfurlLinks: true, unfurlMedia: true }
    );
    expect(result.payload).toMatchObject({
      unfurl_links: true,
      unfurl_media: true,
    });
  });
});

test.describe('send - bot token transport (chat.postMessage)', () => {
  // chat.postMessage's URL is hardcoded in send.ts (it is not a webhook, it
  // has no per-caller URL) - the real endpoint cannot be pointed at a local
  // server, so this exercises it via the `_fetch` seam instead, capturing
  // the real Request the module builds.
  function fakeChatPostMessage(body: { ok: boolean; error?: string }) {
    const calls: { url: string | URL; init: RequestInit }[] = [];
    const fetchImpl = async (
      url: string | URL,
      init: RequestInit
    ): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { calls, fetchImpl };
  }

  test('sends the token as a Bearer Authorization header and the channel/thread_ts in the body', async () => {
    const { calls, fetchImpl } = fakeChatPostMessage({ ok: true });
    const transport: BotTokenTransport = {
      token: 'xoxb-fake',
      channel: '#general',
      threadTs: '111.222',
    };
    const result = await send(MESSAGE, transport, {
      _fetch: fetchImpl as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization
    ).toBe('Bearer xoxb-fake');
    const sentBody = JSON.parse(calls[0].init.body as string);
    expect(sentBody).toMatchObject({
      channel: '#general',
      thread_ts: '111.222',
    });
  });

  test('always returns HTTP 200 - a body of {ok:false, error} is still a failure', async () => {
    const { fetchImpl } = fakeChatPostMessage({
      ok: false,
      error: 'channel_not_found',
    });
    const transport: BotTokenTransport = {
      token: 'xoxb-fake',
      channel: '#general',
    };
    const result = await send(MESSAGE, transport, {
      _fetch: fetchImpl as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.error).toBe('channel_not_found');
    expect(result.retryable).toBe(false);
  });

  test('dry run for a bot token transport never calls fetch, and shapes the payload correctly', async () => {
    const transport: BotTokenTransport = {
      token: 'xoxb-fake',
      channel: '#general',
      threadTs: '111.222',
    };
    const result = await send(MESSAGE, transport, { dryRun: true });
    expect(result.payload).toMatchObject({
      channel: '#general',
      thread_ts: '111.222',
    });
    expect(result.payload).not.toHaveProperty('token');
  });
});

test.describe('send - invalid URL never reaches fetch', () => {
  test('an unparseable webhook URL is rejected before any request, with no echo of the input', async () => {
    const result = await send(MESSAGE, { webhookUrl: 'htp://not a real url' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_url');
    expect(result.error).toBe('invalid_url');
    expect(result.attempts).toBe(0);
  });
});

test.describe('send - the secret never leaks', () => {
  const SECRET_TOKEN = 'SECRETTOKEN0123456789';

  test('assertNoSecret itself: a leak walker that misses non-enumerable or cause-chain secrets is useless - prove it catches both', () => {
    const err = new Error('outer message, clean');
    Object.defineProperty(err, 'message', {
      value: `leaked: ${SECRET_TOKEN}`,
      enumerable: false,
    });
    expect(() => assertNoSecret(err, [SECRET_TOKEN], 'test')).toThrow();

    const withCause = new Error('clean', {
      cause: new Error(`nested ${SECRET_TOKEN}`),
    });
    expect(() => assertNoSecret(withCause, [SECRET_TOKEN], 'test')).toThrow();

    const clean = { a: { b: 'nothing secret here' } };
    expect(() => assertNoSecret(clean, [SECRET_TOKEN], 'test')).not.toThrow();
  });

  test('a result key set is always a subset of the documented allowlist', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const result = await send(MESSAGE, { webhookUrl: slack.url });
    const allowlist = new Set([
      'ok',
      'status',
      'error',
      'code',
      'attempts',
      'retryable',
      'retryAfterMs',
      'durationMs',
      'skipped',
      'reason',
      'payload',
    ]);
    for (const key of Object.keys(result)) {
      expect(allowlist.has(key)).toBe(true);
    }
  });

  test('ECONNREFUSED against a just-closed server does not leak the url in the result', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    await new Promise<void>(resolve => server.close(() => resolve()));

    const url = `http://127.0.0.1:${address.port}/services/T00000000/B00000000/${SECRET_TOKEN}`;
    const result = await send(MESSAGE, { webhookUrl: url }, { maxRetries: 0 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('network_error');
    expect(() =>
      assertNoSecret(result, [url, SECRET_TOKEN], 'ECONNREFUSED result')
    ).not.toThrow();
  });

  test('a DNS failure against a reserved .invalid host does not leak the url', async () => {
    const url = `https://nonexistent-${Date.now()}.invalid/services/T00000000/B00000000/${SECRET_TOKEN}`;
    const result = await send(
      MESSAGE,
      { webhookUrl: url },
      { maxRetries: 0, timeoutMs: 3000 }
    );
    expect(result.ok).toBe(false);
    expect(['network_error', 'timeout']).toContain(result.code);
    expect(() =>
      assertNoSecret(result, [url, SECRET_TOKEN], 'DNS failure result')
    ).not.toThrow();
  });

  test('an unparseable URL (the sharpest case - raw fetch would echo the whole string) does not leak the token', async () => {
    const url = `htp://hooks.slack.com/services/T0000/B0000/${SECRET_TOKEN}`;
    const result = await send(MESSAGE, { webhookUrl: url });
    expect(result.code).toBe('invalid_url');
    expect(() =>
      assertNoSecret(result, [url, SECRET_TOKEN], 'invalid_url result')
    ).not.toThrow();
  });

  test('a redirect is refused rather than followed, so the token cannot reach another host', async ({
    slack,
  }) => {
    slack.respondWith({
      status: 302,
      headers: { location: 'https://attacker.example.com/' },
    });
    const result = await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { maxRetries: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('network_error');
  });

  test('debug output is redacted - the webhook token never appears in a debug line', async ({
    slack,
  }) => {
    slack.respondWith({ status: 503 }, { status: 200, body: 'ok' });
    const lines: string[] = [];
    const { sleep } = recordingSleep();
    await send(
      MESSAGE,
      { webhookUrl: slack.url },
      { debug: l => lines.push(l), _sleep: sleep }
    );
    const tokenSegment = slack.url.split('/').pop()!;
    for (const line of lines) {
      expect(line).not.toContain(tokenSegment);
    }
  });
});

test.describe('send - webhook transport type guard', () => {
  test('a token+channel transport never sets an Authorization header on a webhook call by accident', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const transport: WebhookTransport = { webhookUrl: slack.url };
    await send(MESSAGE, transport);
    expect(slack.requests[0].headers.authorization).toBeUndefined();
  });
});
