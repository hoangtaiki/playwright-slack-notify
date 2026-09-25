import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { summaryFromReport, type RawPlaywrightReport } from '../src/report.js';
import { RAW_REPORT_PATH } from './support/reports.js';

function loadRealReport(): RawPlaywrightReport {
  return JSON.parse(
    readFileSync(RAW_REPORT_PATH, 'utf-8')
  ) as RawPlaywrightReport;
}

test.describe('summaryFromReport - the CLIs own minimal reader, on a REAL report', () => {
  test('counts match the reports own top-level stats block exactly', () => {
    const report = loadRealReport();
    const summary = summaryFromReport(report);
    expect(summary.failed).toBe(report.stats?.unexpected);
    expect(summary.passed).toBe(report.stats?.expected);
    expect(summary.skipped).toBe(report.stats?.skipped);
    expect(summary.duration).toBe(report.stats?.duration);
    expect(summary.startedAt).toBe(report.stats?.startTime);
    // Sanity: the real report actually has non-trivial values here, so this
    // test cannot pass by both sides being undefined.
    expect(summary.failed).toBeGreaterThan(0);
  });

  test('walks nested suites and finds every real failing spec, across both projects', () => {
    const report = loadRealReport();
    const summary = summaryFromReport(report);
    const titles = summary.failures.map(f => f.title);
    expect(titles.some(t => t.includes('SIMPLE-01'))).toBe(true);
    expect(titles.some(t => t.includes('TIMEOUT-01'))).toBe(true);
    expect(
      summary.failures.filter(f => f.project === 'project-a')
    ).toHaveLength(5);
    expect(
      summary.failures.filter(f => f.project === 'project-b')
    ).toHaveLength(5);
  });

  test('outcome is "failed" when the report has real unexpected failures', () => {
    const report = loadRealReport();
    expect(summaryFromReport(report).outcome).toBe('failed');
  });

  test('the real timedOut spec is reported with status timedOut', () => {
    const report = loadRealReport();
    const summary = summaryFromReport(report);
    const timeoutEntry = summary.failures.find(f =>
      f.title.includes('TIMEOUT-01')
    );
    expect(timeoutEntry?.status).toBe('timedOut');
  });
});

test.describe('summaryFromReport - synthetic edge cases (the librarys own input contract, not a fabricated Playwright report)', () => {
  test('a report with no suites at all is outcome passed with zero failures', () => {
    const summary = summaryFromReport({
      suites: [],
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    });
    expect(summary.outcome).toBe('passed');
    expect(summary.failures).toHaveLength(0);
  });

  test('top-level errors force outcome to failed even with zero failing specs', () => {
    const summary = summaryFromReport({
      suites: [],
      errors: [{ message: 'Cannot find module' }],
    });
    expect(summary.outcome).toBe('failed');
    expect(summary.reportErrors).toEqual([{ message: 'Cannot find module' }]);
  });

  test('a describe-less spec at the top level is still found', () => {
    const summary = summaryFromReport({
      suites: [
        {
          title: 'a.spec.ts',
          specs: [
            {
              title: 'top-level test',
              ok: false,
              tests: [{ status: 'failed', results: [{ status: 'failed' }] }],
            },
          ],
        },
      ],
    });
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].title).toBe('a.spec.ts > top-level test');
  });
});
