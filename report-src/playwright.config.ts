import { defineConfig } from '@playwright/test';

// One real report, two projects, five intentionally-failing specs. This
// covers the STRING CONTENT risk surface (long titles, mrkdwn-special
// characters, ANSI codes, multi-line errors, a genuinely retried failure)
// that this package's message-building code has to survive - it does not
// need to re-exercise the report TOPOLOGY edge cases (merge-reports
// duplicate collapsing, abandoned retries, max-failures) that
// playwright-report-analyzer already covers exhaustively, since this
// package consumes already-normalised FailedTest[] output, not raw report
// shapes.
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  projects: [{ name: 'project-a' }, { name: 'project-b' }],
  reporter: [['json']],
});
