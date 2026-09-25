import { readFileSync } from 'node:fs';
import {
  summaryFromReport,
  type RawPlaywrightReport,
} from '../../src/report.js';
import type { RunSummary, TestOutcome } from '../../src/model.js';
import { RAW_REPORT_PATH } from './reports.js';

// Real data, derived from the real report by this package's OWN local
// reader (src/report.ts) - no other Playwright utility package is involved.
// This package works standalone: nothing in its reporter or CLI surfaces
// requires any other package to be installed, and its own tests hold to the
// same rule. Cached per process: the underlying report never changes within
// a test run.

let cached: RunSummary | undefined;

function loadRealReport(): RawPlaywrightReport {
  return JSON.parse(
    readFileSync(RAW_REPORT_PATH, 'utf-8')
  ) as RawPlaywrightReport;
}

/** The real RunSummary for report-src's live run, as this package's own
 *  summaryFromReport() reads it - real titles, real ANSI-coded errors, real
 *  retries, across two real projects. */
export function realRunSummary(): RunSummary {
  cached ??= summaryFromReport(loadRealReport());
  return cached;
}

/** Find the one real failure whose title contains `needle`, or throw with a
 *  clearer message than an undefined `.find()` result surfacing three
 *  assertions later. */
export function findFailure(needle: string): TestOutcome {
  const found = realRunSummary().failures.find(f => f.title.includes(needle));
  if (!found) {
    throw new Error(
      `no real failure found containing "${needle}" - report-src/ may have changed`
    );
  }
  return found;
}
