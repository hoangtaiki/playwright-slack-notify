// The primary surface: a Playwright Reporter that posts a Slack message from
// onEnd(), the runner's real "afterAll" hook - it is awaited
// (testReporter.d.ts:150-151), so the post completes before the run exits.
//
// Imports from '@playwright/test/reporter' are TYPES ONLY. That subpath's
// runtime file is a license header and a comment - "We only export types in
// reporter.d.ts." - with zero exports, so `import type` erases this
// completely and the runtime stays dependency-free, matching this package's
// devDependency-only (optional peerDependency) declaration of
// @playwright/test in package.json.

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
} from '@playwright/test/reporter';
import type { BuildContext, RunSummary, TestOutcome } from './model.js';
import { notify, type NotifyOptions } from './notify.js';
import type { Transport } from './send.js';

export interface SlackReporterOptions extends NotifyOptions {
  readonly webhookUrl?: string;
  readonly token?: string;
  readonly channel?: string;
  readonly username?: string;
  readonly iconEmoji?: string;
  readonly iconUrl?: string;
  readonly threadTs?: string;
  readonly build?: Partial<BuildContext>;
  /** Arbitrary key/value rows for the message - the reporter constructs its
   *  own RunSummary from the live Suite tree, so this is the config-time way
   *  to attach meta (branch, ticket, environment, ...) to it. */
  readonly meta?: readonly { key: string; value: string }[];
}

function toTransport(options: SlackReporterOptions): Transport | undefined {
  if (options.webhookUrl) {
    return {
      webhookUrl: options.webhookUrl,
      channel: options.channel,
      username: options.username,
      iconEmoji: options.iconEmoji,
      iconUrl: options.iconUrl,
    };
  }
  if (options.token && options.channel) {
    return {
      token: options.token,
      channel: options.channel,
      username: options.username,
      iconEmoji: options.iconEmoji,
      iconUrl: options.iconUrl,
      threadTs: options.threadTs,
    };
  }
  return undefined;
}

function testOutcomeFrom(test: TestCase): TestOutcome {
  const titlePath = test.titlePath().filter(Boolean);
  const last = test.results[test.results.length - 1] as
    { error?: { message?: string }; duration?: number } | undefined;
  return {
    title: titlePath.join(' > '),
    titlePath,
    file: test.location.file,
    line: test.location.line,
    column: test.location.column,
    project: test.parent.project()?.name,
    tags: test.tags,
    error: last?.error?.message,
    duration: last?.duration,
    retries: test.results.length > 0 ? test.results.length - 1 : 0,
    // TestCase.outcome() collapses retries into one of
    // 'skipped'|'expected'|'unexpected'|'flaky' - use it, never a raw result
    // status, which is per-ATTEMPT rather than per-test.
    status: test.outcome(),
  };
}

/**
 * Posts a Slack message summarising the whole run. Register it like any
 * other reporter:
 *
 * ```ts
 * reporter: [
 *   ['list'],
 *   ['playwright-slack-notify/reporter', {
 *     webhookUrl: process.env.SLACK_WEBHOOK,
 *     sendResults: 'on-failure',
 *   }],
 * ]
 * ```
 */
export default class SlackNotifyReporter implements Reporter {
  private readonly options: SlackReporterOptions;
  private rootSuite: Suite | undefined;
  private startTime = 0;

  constructor(options: SlackReporterOptions = {}) {
    this.options = options;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.rootSuite = suite;
    this.startTime = Date.now();
  }

  /**
   * Deliberately returns `undefined`, never `{ status }`: Playwright lets a
   * reporter's onEnd OVERRIDE the run's exit code
   * (testReporter.d.ts:150-151), and a notifier must never do that - a
   * broken Slack integration is not a reason to fail the actual test run.
   */
  async onEnd(result: FullResult): Promise<undefined> {
    const transport = toTransport(this.options);
    if (!transport) {
      console.error(
        'playwright-slack-notify: no webhookUrl or token+channel configured on the reporter - skipping'
      );
      return undefined;
    }

    const allTests = this.rootSuite ? this.rootSuite.allTests() : [];
    const failures: TestOutcome[] = [];
    const flakyTests: TestOutcome[] = [];
    let passed = 0;
    let skipped = 0;

    for (const test of allTests) {
      switch (test.outcome()) {
        case 'expected':
          passed++;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'flaky':
          flakyTests.push(testOutcomeFrom(test));
          break;
        case 'unexpected':
          failures.push(testOutcomeFrom(test));
          break;
      }
    }

    // FullResult.status ('passed'|'failed'|'timedout'|'interrupted', all
    // lowercase) is exactly RunSummary['outcome'] - see model.ts's doc on
    // why RunSummary uses that vocabulary rather than TestResult's camelCase
    // one.
    const summary: RunSummary = {
      outcome: result.status,
      passed,
      failed: failures.length,
      flaky: flakyTests.length,
      skipped,
      duration: Date.now() - this.startTime,
      failures,
      flakyTests,
      meta: this.options.meta,
      build: this.options.build as BuildContext | undefined,
    };

    try {
      const sendResult = await notify(summary, transport, this.options);
      if (!sendResult.ok && !sendResult.skipped) {
        console.error(
          `playwright-slack-notify: failed to post to Slack (${sendResult.code ?? 'unknown'}${sendResult.error ? `: ${sendResult.error}` : ''})`
        );
      }
    } catch {
      // notify()/send() do not reject in normal operation - this guards
      // only against a bug in a caller-supplied layout/layoutAsync throwing,
      // so a Slack integration failure can never fail the actual test run.
      console.error(
        'playwright-slack-notify: unexpected error while posting to Slack'
      );
    }

    return undefined;
  }

  printsToStdio(): boolean {
    return false;
  }
}
