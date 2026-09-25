import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  REPORT_SRC_DIR,
  REPORTS_DIR,
  RAW_REPORT_PATH,
} from './support/reports.js';

/**
 * Produce the one report this suite asserts realistic string content
 * against, by REALLY running Playwright over report-src/. Nothing here is
 * hand-authored and nothing is committed; `.tmp-reports/` is wiped and
 * rebuilt on every run.
 *
 * Unlike playwright-report-analyzer's own global setup, this needs no
 * merge-reports choreography - this package consumes already-normalised
 * FailedTest[] output, so a single ordinary run is enough. See
 * report-src/playwright.config.ts's doc comment for why.
 */

/** Absolute path to Playwright's own CLI entrypoint, resolved and run
 *  through `process.execPath` rather than shelling out to `npx`: on Windows
 *  `npx` is `npx.cmd`, which `execFileSync` cannot launch without a shell. */
const PLAYWRIGHT_CLI = (() => {
  const require = createRequire(import.meta.url);
  for (const pkg of ['playwright', '@playwright/test']) {
    try {
      const manifestPath = require.resolve(`${pkg}/package.json`);
      const manifest = require(`${pkg}/package.json`) as {
        bin?: Record<string, string>;
      };
      const bin = manifest.bin?.playwright;
      if (bin) return path.join(path.dirname(manifestPath), bin);
    } catch {
      // Try the next package.
    }
  }
  throw new Error(
    'global setup: could not locate the Playwright CLI. Is @playwright/test installed?'
  );
})();

export default function globalSetup(): void {
  if (process.env.SKIP_REPORT_GEN && existsSync(RAW_REPORT_PATH)) return;

  rmSync(REPORTS_DIR, { recursive: true, force: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_FILE: RAW_REPORT_PATH,
  };
  // c8 instruments this process; the child must not inherit that, or it
  // writes coverage fragments for code under test it never loaded.
  delete env.NODE_V8_COVERAGE;

  let output = '';
  try {
    output = execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'test'], {
      cwd: REPORT_SRC_DIR,
      env,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (err) {
    // Expected: every spec under report-src/ is meant to fail. Keep the
    // output anyway - if the report is missing, this is the only clue why.
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
    output = [String(e.stdout ?? ''), String(e.stderr ?? e.message ?? '')].join(
      '\n'
    );
  }

  if (!existsSync(RAW_REPORT_PATH)) {
    throw new Error(
      [
        `global setup: Playwright produced no report at ${RAW_REPORT_PATH}.`,
        `CLI: ${PLAYWRIGHT_CLI}`,
        `Output from the run:\n${output.slice(-4000)}`,
      ].join('\n')
    );
  }
  try {
    JSON.parse(readFileSync(RAW_REPORT_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `global setup: the report at ${RAW_REPORT_PATH} is not valid JSON: ${(err as Error).message}`
    );
  }

  for (const dir of ['test-results', 'playwright-report', 'blob-report']) {
    rmSync(path.join(REPORT_SRC_DIR, dir), { recursive: true, force: true });
  }
}
