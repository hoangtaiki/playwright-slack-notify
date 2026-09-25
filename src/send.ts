// Posts a built message to Slack, over a legacy incoming webhook or a bot
// token (chat.postMessage). Zero runtime dependencies: uses the global
// `fetch` (Node >= 18) and AbortSignal.timeout (Node >= 17.3), both globals.
//
// The webhook URL must never appear in a result, a thrown error, or a log -
// see the module doc on secretsFor()/redact() and the design's "secret-leak
// requirement". send() never rejects and never returns exception-derived
// text; every failure becomes a SendResult with a code from a closed set.

import type { SlackMessage } from './blocks.js';

export type SendErrorCode =
  | 'http_error'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'invalid_url'
  | 'aborted';

export interface SendResult {
  readonly ok: boolean;
  readonly status?: number;
  /** Slack's own error string (webhook: a plain string like
   *  'invalid_payload'; bot token: the `error` field of a `{ok:false}` body),
   *  or one of SendErrorCode when there was no Slack response to report. */
  readonly error?: string;
  readonly code?: SendErrorCode;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly durationMs: number;
  readonly skipped?: boolean;
  readonly reason?: string;
  /** Only populated by a dry run - the exact payload that would have been
   *  sent, for eyeballing before the one live post that settles the
   *  legacy-hook question (see the plan's open items). */
  readonly payload?: Record<string, unknown>;
}

interface CommonOverrides {
  readonly channel?: string;
  readonly username?: string;
  readonly iconEmoji?: string;
  readonly iconUrl?: string;
}

export interface WebhookTransport extends CommonOverrides {
  readonly webhookUrl: string;
}

export interface BotTokenTransport extends CommonOverrides {
  readonly token: string;
  readonly channel: string;
  readonly threadTs?: string;
}

export type Transport = WebhookTransport | BotTokenTransport;

export interface SendOptions {
  /** 'text' is the one-flag fallback for the unresolved question of whether
   *  a legacy webhook honours channel/username/icon_emoji ALONGSIDE blocks -
   *  see the plan's open items. Default 'blocks'. */
  readonly render?: 'blocks' | 'text';
  /** Returns the exact payload without sending - see SendResult.payload. */
  readonly dryRun?: boolean;
  readonly unfurlLinks?: boolean;
  readonly unfurlMedia?: boolean;
  readonly maxRetries?: number;
  /** Retry-After (seconds, per Slack's docs) is clamped to this so a
   *  rate-limited CI job cannot sleep for an hour. Also the ceiling for our
   *  own exponential backoff. */
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  /** Receives already-redacted diagnostic lines - never the webhook URL. */
  readonly debug?: (line: string) => void;
  /** @internal exported for testing - injected so retry delays are asserted
   *  exactly rather than waited on. */
  readonly _sleep?: (ms: number) => Promise<void>;
  /** @internal exported for testing */
  readonly _random?: () => number;
  /** @internal exported for testing - a real loopback server stands in for
   *  Slack; this seam exists only for the handful of cases a real server
   *  cannot cheaply simulate (see tests/support/slack-server.ts). */
  readonly _fetch?: typeof fetch;
}

function isWebhookTransport(t: Transport): t is WebhookTransport {
  return 'webhookUrl' in t;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const BASE_DELAY_MS = 500;

/** Equal jitter: half the exponential backoff is guaranteed delay, half is
 *  random - avoids both a thundering herd (pure random) and no jitter at all
 *  (pure exponential). */
function computeBackoffMs(
  attemptIndex: number,
  maxDelayMs: number,
  random: () => number
): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** attemptIndex, maxDelayMs);
  return Math.round(base / 2 + random() * (base / 2));
}

/** Integer seconds only, per Slack's documented Retry-After. Anything else
 *  (absent, an HTTP-date string, garbage) is not a number and falls back to
 *  our own backoff instead. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/** Every string derived from `url` that must never appear in a log line -
 *  the whole URL, host+path, path alone, and any path segment of 8+ chars
 *  (the T.../B.../token segments of a real Slack webhook). */
function secretsFor(url: string): string[] {
  const secrets = [url];
  try {
    const u = new URL(url);
    secrets.push(u.pathname);
    secrets.push(u.host + u.pathname);
    for (const seg of u.pathname.split('/')) {
      if (seg.length >= 8) secrets.push(seg);
    }
  } catch {
    // Unparseable - the whole string is already in `secrets`.
  }
  return secrets;
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 4) continue; // avoid redacting trivial substrings
    out = out.split(s).join('[redacted]');
  }
  return out;
}

function buildPayload(
  message: SlackMessage,
  transport: Transport,
  render: 'blocks' | 'text',
  unfurlLinks: boolean,
  unfurlMedia: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    text: message.text,
    unfurl_links: unfurlLinks,
    unfurl_media: unfurlMedia,
  };
  if (render === 'blocks') payload.blocks = message.blocks;
  if (transport.channel) payload.channel = transport.channel;
  if (transport.username) payload.username = transport.username;
  if (transport.iconEmoji) payload.icon_emoji = transport.iconEmoji;
  if (transport.iconUrl) payload.icon_url = transport.iconUrl;
  if (!isWebhookTransport(transport) && transport.threadTs) {
    payload.thread_ts = transport.threadTs;
  }
  return payload;
}

const CHAT_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/**
 * Post `message` to Slack. Never rejects, never throws - every outcome,
 * including a network failure or an unparseable URL, comes back as a
 * SendResult. See the module doc for why: the webhook URL must not be able
 * to leak through an uncaught exception's message or stack.
 */
export async function send(
  message: SlackMessage,
  transport: Transport,
  options: SendOptions = {}
): Promise<SendResult> {
  const started = Date.now();
  const render = options.render ?? 'blocks';
  const unfurlLinks = options.unfurlLinks ?? false;
  const unfurlMedia = options.unfurlMedia ?? false;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep =
    options._sleep ??
    ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const random = options._random ?? Math.random;
  const doFetch = options._fetch ?? fetch;

  const endpoint = isWebhookTransport(transport)
    ? transport.webhookUrl
    : CHAT_POST_MESSAGE_URL;
  const secrets = isWebhookTransport(transport)
    ? secretsFor(transport.webhookUrl)
    : [];
  const debugLine = (line: string) => options.debug?.(redact(line, secrets));

  // Validated BEFORE fetch is ever called: fetch() on an unparseable input
  // throws `TypeError: Failed to parse URL from <the whole input>`, which
  // would embed the token verbatim in the exception message. URL.canParse
  // alone is not enough - "htp://host/token" parses fine as a generic URI
  // (the WHATWG parser does not validate against a fixed scheme list), so
  // the protocol must be checked too, or a typo'd scheme reaches fetch()
  // instead of failing here.
  if (
    !URL.canParse(endpoint) ||
    !/^https?:$/.test(new URL(endpoint).protocol)
  ) {
    return {
      ok: false,
      code: 'invalid_url',
      error: 'invalid_url',
      attempts: 0,
      retryable: false,
      durationMs: Date.now() - started,
    };
  }

  const payload = buildPayload(
    message,
    transport,
    render,
    unfurlLinks,
    unfurlMedia
  );

  if (options.dryRun) {
    return {
      ok: true,
      skipped: true,
      reason: 'dry-run',
      attempts: 0,
      retryable: false,
      durationMs: Date.now() - started,
      payload,
    };
  }

  let attempts = 0;
  let lastError: string | undefined;
  let lastCode: SendErrorCode | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isWebhookTransport(transport)
            ? {}
            : { Authorization: `Bearer ${transport.token}` }),
        },
        body: JSON.stringify(payload),
        // A redirect could carry the token to another host - refuse rather
        // than follow it.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | undefined)?.name;
      lastCode =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'timeout'
          : 'network_error';
      lastError = lastCode;
      debugLine(`attempt ${attempts} failed: ${lastCode}`);
      if (attempt < maxRetries) {
        await sleep(computeBackoffMs(attempt, maxDelayMs, random));
        continue;
      }
      return {
        ok: false,
        code: lastCode,
        error: lastError,
        attempts,
        retryable: true,
        durationMs: Date.now() - started,
      };
    }

    if (response.status === 429) {
      const rawRetryAfterMs = parseRetryAfterMs(
        response.headers.get('retry-after')
      );
      const retryAfterMs =
        rawRetryAfterMs !== undefined
          ? Math.min(rawRetryAfterMs, maxDelayMs)
          : undefined;
      await response.text().catch(() => undefined);
      if (attempt < maxRetries) {
        const delay =
          retryAfterMs ?? computeBackoffMs(attempt, maxDelayMs, random);
        debugLine(`rate limited, retrying after ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        error: 'rate_limited',
        attempts,
        retryable: true,
        retryAfterMs,
        durationMs: Date.now() - started,
      };
    }

    if (isWebhookTransport(transport)) {
      const bodyText = await response.text().catch(() => '');
      if (response.status === 200 && bodyText.trim() === 'ok') {
        return {
          ok: true,
          status: 200,
          attempts,
          retryable: false,
          durationMs: Date.now() - started,
        };
      }
      const retryable = response.status >= 500;
      lastError = bodyText.trim() || `http_${response.status}`;
      lastCode = 'http_error';
      if (retryable && attempt < maxRetries) {
        const delay = computeBackoffMs(attempt, maxDelayMs, random);
        debugLine(
          `attempt ${attempts} got ${response.status}, retrying after ${delay}ms`
        );
        await sleep(delay);
        continue;
      }
      return {
        ok: false,
        status: response.status,
        code: 'http_error',
        error: lastError,
        attempts,
        retryable,
        durationMs: Date.now() - started,
      };
    }

    // chat.postMessage ALWAYS returns HTTP 200 - success/failure is only in
    // the response body, never the status code.
    let body: { ok?: boolean; error?: string } = {};
    try {
      body = (await response.json()) as { ok?: boolean; error?: string };
    } catch {
      body = {};
    }
    if (body.ok) {
      return {
        ok: true,
        status: response.status,
        attempts,
        retryable: false,
        durationMs: Date.now() - started,
      };
    }
    const retryable = body.error === 'rate_limited';
    lastError = body.error ?? 'unknown_error';
    lastCode = 'http_error';
    if (retryable && attempt < maxRetries) {
      await sleep(computeBackoffMs(attempt, maxDelayMs, random));
      continue;
    }
    return {
      ok: false,
      status: response.status,
      code: 'http_error',
      error: lastError,
      attempts,
      retryable,
      durationMs: Date.now() - started,
    };
  }

  // Unreachable when maxRetries >= 0 (every branch above returns), kept as a
  // type-safe fallback for a caller passing a negative maxRetries.
  return {
    ok: false,
    code: lastCode ?? 'network_error',
    error: lastError ?? 'unknown_error',
    attempts,
    retryable: true,
    durationMs: Date.now() - started,
  };
}
