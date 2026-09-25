import { test, expect } from '@playwright/test';
import { fromAnalysis, fromFailedTests } from '../src/adapt.js';

// fromFailedTests/fromAnalysis are generic bridges for THIS PACKAGE'S OWN
// declared input contract (FailedTestLike[] / AnalyzeResultLike) - not a
// snapshot of another tool's output. Hand-constructing objects of that
// shape here is the same class of exception the sibling project's own
// tests take for ITS input type (FailedTest objects in grep.spec.ts):
// these are the library's own types, so there is nothing to fabricate.

test.describe('fromFailedTests', () => {
  test('derives failed/flaky/passed counts from the array itself when no summary is given', () => {
    const result = fromFailedTests([
      { title: 'a.spec.ts > one', status: 'failed' },
      { title: 'a.spec.ts > two', status: 'timedOut' },
    ]);
    expect(result.passed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.flakyTests).toHaveLength(0);
  });

  test('a summary override supplies the totals a bare array cannot carry', () => {
    const result = fromFailedTests(
      [{ title: 'a.spec.ts > one', status: 'failed' }],
      {
        summary: {
          passed: 128,
          failed: 1,
          flaky: 2,
          skipped: 4,
          duration: 7000,
          startTime: '2026-01-01T00:00:00Z',
        },
      }
    );
    expect(result.passed).toBe(128);
    expect(result.failed).toBe(1);
    expect(result.flaky).toBe(2);
    expect(result.skipped).toBe(4);
    expect(result.duration).toBe(7000);
    expect(result.startedAt).toBe('2026-01-01T00:00:00Z');
  });

  test('a status: "flaky" entry is split into flakyTests, not failures', () => {
    const result = fromFailedTests([
      { title: 'a > hard-fail', status: 'failed' },
      { title: 'a > flaky-one', status: 'flaky' },
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].title).toBe('a > hard-fail');
    expect(result.flakyTests).toHaveLength(1);
    expect(result.flakyTests?.[0].title).toBe('a > flaky-one');
  });

  test('report errors force outcome to "failed" even with zero array entries', () => {
    const result = fromFailedTests([], { reportErrors: [{ message: 'boom' }] });
    expect(result.outcome).toBe('failed');
  });

  test('an empty array with no report errors is outcome "passed"', () => {
    const result = fromFailedTests([]);
    expect(result.outcome).toBe('passed');
  });

  test('build and meta pass through untouched', () => {
    const result = fromFailedTests([], {
      build: { job: 'j', buildNumber: 1 },
      meta: [{ key: 'Branch', value: 'main' }],
    });
    expect(result.build).toEqual({ job: 'j', buildNumber: 1 });
    expect(result.meta).toEqual([{ key: 'Branch', value: 'main' }]);
  });

  test('every field on a FailedTestLike entry carries through to TestOutcome', () => {
    const result = fromFailedTests([
      {
        title: 'a.spec.ts > b',
        titlePath: ['a.spec.ts', 'b'],
        file: 'a.spec.ts',
        line: 10,
        column: 3,
        project: 'chromium',
        tags: ['smoke'],
        error: 'boom',
        errorStack: 'boom\n  at x',
        duration: 42,
        retries: 2,
        status: 'timedOut',
      },
    ]);
    expect(result.failures[0]).toEqual({
      title: 'a.spec.ts > b',
      titlePath: ['a.spec.ts', 'b'],
      file: 'a.spec.ts',
      line: 10,
      column: 3,
      project: 'chromium',
      tags: ['smoke'],
      error: 'boom',
      duration: 42,
      retries: 2,
      status: 'timedOut',
    });
  });
});

test.describe('fromAnalysis', () => {
  test('adapts an analyze()-shaped result (summary + failed) in one call', () => {
    const result = fromAnalysis({
      summary: {
        total: 10,
        passed: 8,
        failed: 2,
        flaky: 0,
        skipped: 0,
        duration: 5000,
        startTime: '2026-01-01T00:00:00Z',
        reportErrors: 0,
        ok: false,
      },
      failed: [
        { title: 'a > one', status: 'failed' },
        { title: 'a > two', status: 'failed' },
      ],
    });
    expect(result.failed).toBe(2);
    expect(result.passed).toBe(8);
    expect(result.duration).toBe(5000);
    expect(result.failures).toHaveLength(2);
  });

  test('extra options (build, meta) pass through alongside the analysis', () => {
    const result = fromAnalysis(
      { summary: { passed: 0, failed: 0 }, failed: [] },
      { build: { job: 'j' }, meta: [{ key: 'k', value: 'v' }] }
    );
    expect(result.build).toEqual({ job: 'j' });
    expect(result.meta).toEqual([{ key: 'k', value: 'v' }]);
  });
});
