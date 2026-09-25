// A generic bridge for a FailedTest[]-shaped array, structurally - never a
// hard dependency on any one producer. playwright-report-analyzer is the
// package this was designed against, but nothing here imports it, requires
// it, or checks where the array came from: any tool emitting the same shape
// works identically. This package has NO dependency, dev or otherwise, on
// any other Playwright utility package - not even in its own tests, which
// derive real data from this package's OWN local report reader
// (src/report.ts) instead. It works standalone, including through its
// reporter and CLI surfaces, with nothing else installed at all.

import type { BuildContext, RunSummary, TestOutcome } from './model.js';

/** Structural mirror of playwright-report-analyzer's FailedTest. Every
 *  field but `title` is optional, and every field is at least as WIDE as the
 *  extractor's - see TestOutcome's doc comment for why that direction
 *  matters. */
export interface FailedTestLike {
  readonly title: string;
  readonly titlePath?: readonly string[];
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly project?: string;
  readonly tags?: readonly string[];
  readonly error?: string;
  readonly errorStack?: string;
  readonly duration?: number;
  readonly retries?: number;
  readonly status?: string;
}

/** Structural mirror of playwright-report-analyzer's `TestSummary` (from
 *  `extractSummary()`/`analyze()`). Field names match that type exactly -
 *  `passed`/`failed`, not Playwright's own report.stats `expected`/
 *  `unexpected` naming, which the extractor deliberately does not use for
 *  reasons documented on its own `extractRawStats` (double-counting and an
 *  unreachable 'flaky' across a rerun-merge). `total`, `reportErrors` (a
 *  COUNT, not messages - see `reportErrors` below for those) and `ok` are
 *  accepted but not currently read by this adapter. */
export interface TestSummaryLike {
  readonly total?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly flaky?: number;
  readonly skipped?: number;
  readonly duration?: number;
  readonly startTime?: string;
  readonly reportErrors?: number;
  readonly ok?: boolean;
}

export interface FromFailedTestsOptions {
  readonly build?: BuildContext;
  readonly meta?: readonly { key: string; value: string }[];
  /** Totals from the report (e.g. via `extractSummary()`/`analyze()`).
   *  Without these, `passed`/`skipped` stay 0 - a FailedTest[] array on its
   *  own carries no information about tests that did not fail. */
  readonly summary?: TestSummaryLike;
  /** The actual report-error MESSAGES (from `extractReportErrors()`) -
   *  distinct from `summary.reportErrors`, which is only a count. */
  readonly reportErrors?: readonly { readonly message?: string }[];
}

/** Structural mirror of playwright-report-analyzer's `AnalyzeResult` - the
 *  extractor's own recommended entry point, giving a trustworthy summary and
 *  the failed-tests list from a single walk. */
export interface AnalyzeResultLike {
  readonly summary: TestSummaryLike;
  readonly failed: readonly FailedTestLike[];
}

function toTestOutcome(t: FailedTestLike): TestOutcome {
  return {
    title: t.title,
    titlePath: t.titlePath,
    file: t.file,
    line: t.line,
    column: t.column,
    project: t.project,
    tags: t.tags,
    error: t.error,
    duration: t.duration,
    retries: t.retries,
    status: t.status,
  };
}

/**
 * Adapt a `FailedTest[]` (from playwright-report-analyzer, or anything
 * structurally shaped like it) into a RunSummary.
 *
 * Splits out any entry with `status === 'flaky'` into `flakyTests`. This is
 * a no-op for the extractor's OWN output today: its `FailedTest.status`
 * union - `'failed'|'timedOut'|'interrupted'|'passed'|'skipped'` - has no
 * `'flaky'` member, so a flaky recovery pulled in via `includeFlaky: true`
 * is indistinguishable from an ordinary `test.fail()` that unexpectedly
 * passed, and lands in `failures` like everything else. The split exists for
 * any OTHER producer that does emit that status - this package's own
 * reporter.ts, via Playwright's real `TestCase.outcome()`, which really
 * does return the literal `'flaky'`.
 *
 * `options.summary?.flaky` (from `extractSummary()`) still gives the
 * aggregate flaky COUNT even though the individual flaky test NAMES are not
 * recoverable from `FailedTest[]` alone - a real, documented limitation of
 * this bridge, not a bug.
 */
export function fromFailedTests(
  failed: readonly FailedTestLike[],
  options: FromFailedTestsOptions = {}
): RunSummary {
  const flakyEntries = failed.filter(t => t.status === 'flaky');
  const hardFailures = failed.filter(t => t.status !== 'flaky');

  const failedCount = options.summary?.failed ?? hardFailures.length;
  const flakyCount = options.summary?.flaky ?? flakyEntries.length;
  const passedCount = options.summary?.passed ?? 0;
  const skippedCount = options.summary?.skipped ?? 0;
  const hasReportErrors = (options.reportErrors?.length ?? 0) > 0;

  const outcome: RunSummary['outcome'] =
    hasReportErrors || failedCount > 0 ? 'failed' : 'passed';

  return {
    outcome,
    passed: passedCount,
    failed: failedCount,
    flaky: flakyCount,
    skipped: skippedCount,
    duration: options.summary?.duration,
    startedAt: options.summary?.startTime,
    failures: hardFailures.map(toTestOutcome),
    flakyTests: flakyEntries.map(toTestOutcome),
    reportErrors: options.reportErrors,
    meta: options.meta,
    build: options.build,
  };
}

/**
 * Adapt an `analyze()` result (playwright-report-analyzer's own recommended
 * entry point - one walk, a trustworthy summary AND the failed list) into a
 * RunSummary. A thin convenience over `fromFailedTests` for the common case
 * of having both pieces already together; nothing here `analyze()`'s two
 * separate calls (`extractFailedTests` + `extractSummary`) could not also
 * produce.
 */
export function fromAnalysis(
  analysis: AnalyzeResultLike,
  extra: Omit<FromFailedTestsOptions, 'summary'> = {}
): RunSummary {
  return fromFailedTests(analysis.failed, {
    ...extra,
    summary: analysis.summary,
  });
}
