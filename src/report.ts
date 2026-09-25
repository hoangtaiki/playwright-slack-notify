// A minimal, LOCAL Playwright JSON report reader - not a replacement for
// playwright-report-analyzer, and deliberately not as rigorous. It exists
// only so the CLI can accept a raw report directly for the simple,
// single-run case, without a runtime dependency on the extractor.
//
// It does NOT implement mergeDuplicateSpecEntries/groupByProject-style
// collapsing of duplicate spec entries that `merge-reports` can produce -
// see that package's src/extract.ts for why that is a real, documented
// upstream Playwright quirk. For a sharded or rerun-and-merge report, the
// correct path is the one the README's sharding recipe already uses: pipe
// through `playwright-report-analyzer` first, and feed THIS module the
// resulting FailedTest[] via adapt.ts's fromFailedTests() instead.

import type { RunSummary, TestOutcome } from './model.js';

interface RawResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string };
  errors?: { message?: string }[];
}

interface RawTestCase {
  projectName?: string;
  status?: string;
  results?: RawResult[];
}

interface RawSpec {
  title: string;
  ok: boolean;
  tags?: string[];
  file?: string;
  line?: number;
  column?: number;
  tests?: RawTestCase[];
}

interface RawSuite {
  title: string;
  file?: string;
  specs?: RawSpec[];
  suites?: RawSuite[];
}

interface RawStats {
  startTime?: string;
  duration?: number;
  expected?: number;
  unexpected?: number;
  flaky?: number;
  skipped?: number;
}

export interface RawPlaywrightReport {
  suites?: RawSuite[];
  errors?: { message?: string }[];
  stats?: RawStats;
}

interface Walked {
  readonly spec: RawSpec;
  readonly titlePath: string[];
}

function walkSpecs(
  suites: RawSuite[] | undefined,
  titlePath: string[],
  out: Walked[]
): void {
  for (const suite of suites ?? []) {
    const nextPath = suite.title ? [...titlePath, suite.title] : titlePath;
    for (const spec of suite.specs ?? []) {
      out.push({ spec, titlePath: [...nextPath, spec.title] });
    }
    walkSpecs(suite.suites, nextPath, out);
  }
}

function toOutcome(entry: Walked): TestOutcome {
  const { spec, titlePath } = entry;
  const test = spec.tests?.[0];
  const result = test?.results?.[test.results.length - 1];
  return {
    title: titlePath.join(' > '),
    titlePath,
    file: spec.file,
    line: spec.line,
    column: spec.column,
    project: test?.projectName,
    tags: spec.tags,
    error: result?.error?.message ?? result?.errors?.[0]?.message,
    duration: result?.duration,
    retries: result ? result.retry : undefined,
    // result.status ('failed'|'timedOut'|'interrupted'|'passed'|'skipped')
    // is the per-ATTEMPT outcome and must win - test.status
    // ('unexpected'|'expected'|'flaky'|'skipped') is Playwright's coarser
    // TestCase-level classification and would otherwise mask a real
    // 'timedOut'/'interrupted' behind the generic 'unexpected'.
    status: result?.status ?? test?.status,
  };
}

/** Build a RunSummary directly from a raw Playwright JSON report. See the
 *  module doc for what this does NOT handle. */
export function summaryFromReport(report: RawPlaywrightReport): RunSummary {
  const all: Walked[] = [];
  walkSpecs(report.suites, [], all);

  const failing = all.filter(e => e.spec.ok === false);
  const flakyEntries = failing.filter(
    e => e.spec.tests?.[0]?.status === 'flaky'
  );
  const hardFailures = failing.filter(
    e => e.spec.tests?.[0]?.status !== 'flaky'
  );

  const stats = report.stats ?? {};
  const hasReportErrors = (report.errors?.length ?? 0) > 0;
  const failedCount = stats.unexpected ?? hardFailures.length;
  const outcome: RunSummary['outcome'] =
    hasReportErrors || failedCount > 0 ? 'failed' : 'passed';

  return {
    outcome,
    passed: stats.expected ?? 0,
    failed: failedCount,
    flaky: stats.flaky ?? flakyEntries.length,
    skipped: stats.skipped ?? 0,
    duration: stats.duration,
    startedAt: stats.startTime,
    failures: hardFailures.map(toOutcome),
    flakyTests: flakyEntries.map(toOutcome),
    reportErrors: report.errors,
  };
}
