// Ties buildMessageAsync() and send() together, and owns the "when to stay
// silent" gate - see the design doc's section of the same name. This is what
// the reporter calls, and what the CLI and the plain library surface call
// too, so the gate is applied exactly once, in one place.

import type { RunSummary } from './model.js';
import { buildMessageAsync, type MessageOptions } from './message.js';
import {
  send,
  type SendOptions,
  type SendResult,
  type Transport,
} from './send.js';

export interface NotifyOptions extends MessageOptions, SendOptions {
  /** 'always' posts unconditionally. 'on-failure' (the default) applies the
   *  silence gate below. 'off' never posts (and never builds a message or
   *  makes a network call). */
  readonly sendResults?: 'always' | 'on-failure' | 'off';
}

/**
 * `sendResults: 'on-failure'` posts if ANY of these hold, and stays silent
 * only when all are clear:
 *  - failed > 0
 *  - flaky > 0 (gated by notifyOnFlaky, default true)
 *  - reportErrors is non-empty
 *  - outcome !== 'passed'
 *
 * The flaky condition is not optional decoration: this package is named for
 * all outcomes, not just failures, and the message renders a flaky count -
 * skipping a flaky-only run would contradict both. The reportErrors
 * condition is kept even though `outcome !== 'passed'` usually covers the
 * same case, because a RunSummary built from a merged report on the CLI path
 * has no FullResult and a derived `outcome` - a report with a non-empty
 * top-level `errors[]` and zero failed specs is exactly the
 * silent-empty-output failure playwright-report-analyzer exists to
 * prevent, and it must not be swallowed here either.
 */
function shouldNotify(
  summary: RunSummary,
  mode: 'always' | 'on-failure' | 'off',
  notifyOnFlaky: boolean
): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  if (summary.failed > 0) return true;
  if (notifyOnFlaky && summary.flaky > 0) return true;
  if (summary.reportErrors && summary.reportErrors.length > 0) return true;
  return summary.outcome !== 'passed';
}

/**
 * Build (if warranted) and send a message for `summary`. Never throws -
 * everything comes back as a NotifyResult, matching send()'s own contract.
 */
export async function notify(
  summary: RunSummary,
  transport: Transport,
  options: NotifyOptions = {}
): Promise<SendResult> {
  const mode = options.sendResults ?? 'on-failure';
  const notifyOnFlaky = options.notifyOnFlaky ?? true;

  if (!shouldNotify(summary, mode, notifyOnFlaky)) {
    return {
      ok: true,
      skipped: true,
      reason: 'nothing-to-report',
      attempts: 0,
      retryable: false,
      durationMs: 0,
    };
  }

  const message = await buildMessageAsync(summary, options);
  return send(message, transport, options);
}
