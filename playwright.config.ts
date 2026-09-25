import { defineConfig } from '@playwright/test';

// This package has no browser runtime coupling - Playwright Test is used
// purely as the unit-test runner for a Node library, matching the
// @playwright/test devDependency (not peerDependency) in package.json.
//
// globalSetup produces the one real report this suite asserts realistic
// FailedTest[] content against, by really running Playwright over
// report-src/. Set SKIP_REPORT_GEN=1 to reuse the previous run's report
// while iterating locally.
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  reporter: [['html', { outputFolder: './playwright-report' }], ['list']],
});
