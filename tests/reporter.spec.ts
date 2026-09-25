import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './support/slack-server.js';
import { REPORTS_DIR } from './support/reports.js';

/**
 * Proves the reporter really runs under a real Playwright process, not just
 * that it typechecks against `@playwright/test/reporter`'s types. A scratch
 * project registers the BUILT reporter (dist/reporter.js) against the
 * loopback server and runs one real failing test; this asserts on what the
 * server actually received.
 */

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
  throw new Error('reporter.spec.ts: could not locate the Playwright CLI');
})();

const DIST_REPORTER = path
  .join(import.meta.dirname, '..', 'dist', 'reporter.js')
  .replace(/\\/g, '/');

const execFileAsync = promisify(execFile);

test.describe('SlackNotifyReporter - a real Playwright run against the loopback server', () => {
  test('posts a real message, from a real Playwright process, when a real test fails', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });

    const scratchDir = path.join(REPORTS_DIR, 'reporter-scratch');
    rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(path.join(scratchDir, 'specs'), { recursive: true });

    // .mjs forces ESM regardless of any package.json this scratch directory
    // does or does not have - Node determines module type per-file from the
    // NEAREST package.json, and the scratch directory has none of its own.
    writeFileSync(
      path.join(scratchDir, 'playwright.config.mjs'),
      `export default {
  testDir: './specs',
  reporter: [['${DIST_REPORTER}', { webhookUrl: '${slack.url}', sendResults: 'always', maxTests: 5 }]],
};\n`
    );
    writeFileSync(
      path.join(scratchDir, 'specs', 'basic.spec.mjs'),
      `import { test } from '@playwright/test';
test('REPORTER-01: a real failure the reporter must post', () => {
  throw new Error('deliberate failure for the reporter integration test');
});
test('REPORTER-02: a real pass', () => {});
`
    );

    // Unlike global-setup.ts's children (which only run report-src's
    // intentionally-failing FIXTURE specs, never this package's own code),
    // this child genuinely executes dist/reporter.js - so NODE_V8_COVERAGE
    // is deliberately NOT deleted here. Each process V8 coverage runs under
    // writes its own JSON file into that same directory; c8's report step
    // aggregates all of them, so leaving it set is what lets `npm run
    // coverage` see reporter.ts's real, cross-process execution at all.
    const env: NodeJS.ProcessEnv = { ...process.env };

    try {
      // MUST be the async execFile, not execFileSync: execFileSync blocks
      // this process's entire event loop while it waits, and the loopback
      // server the scratch project's reporter needs to reach lives in THIS
      // SAME process (the `slack` fixture). A blocked event loop cannot
      // accept the incoming connection, so the child's fetch() would retry
      // and time out repeatedly - about 40s, in exactly the shape of a real
      // network failure - never actually reaching the server at all.
      await execFileAsync(process.execPath, [PLAYWRIGHT_CLI, 'test'], {
        cwd: scratchDir,
        env,
      });
    } catch {
      // The scratch project is DESIGNED to fail one test - that failure is
      // expected and irrelevant here; what matters is the Slack POST it
      // caused, asserted below.
    }

    expect(slack.requests).toHaveLength(1);
    expect(slack.requests[0].headers['content-type']).toBe('application/json');

    const body = slack.requests[0].body as { text: string; blocks: unknown[] };
    expect(body.text).toContain('Build Failure');
    const blocksText = JSON.stringify(body.blocks);
    expect(blocksText).toContain('REPORTER-01');
    expect(blocksText).not.toContain('REPORTER-02'); // a real pass, not listed
    expect(blocksText).toContain('1 failed');
    expect(blocksText).toContain('1 passed');
  });

  test('a GitHub Actions environment adds a build link with no `build` option configured', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });

    // A separate scratch dir from the test above - both tests can run
    // concurrently under fullyParallel, and sharing one dir would race.
    const scratchDir = path.join(REPORTS_DIR, 'reporter-scratch-ci-build');
    rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(path.join(scratchDir, 'specs'), { recursive: true });

    writeFileSync(
      path.join(scratchDir, 'playwright.config.mjs'),
      `export default {
  testDir: './specs',
  reporter: [['${DIST_REPORTER}', { webhookUrl: '${slack.url}', sendResults: 'always' }]],
};\n`
    );
    writeFileSync(
      path.join(scratchDir, 'specs', 'basic.spec.mjs'),
      `import { test } from '@playwright/test';
test('CIBUILD-01: a real failure', () => {
  throw new Error('deliberate failure');
});
`
    );

    // Only these keys need overriding - the rest of process.env passes
    // through unchanged, same as the test above.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_RUN_ID: '4200',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_ACTOR: 'hoang',
      GITHUB_SHA: 'deadbeef',
    };

    try {
      await execFileAsync(process.execPath, [PLAYWRIGHT_CLI, 'test'], {
        cwd: scratchDir,
        env,
      });
    } catch {
      // Expected - the scratch project's one test deliberately fails.
    }

    expect(slack.requests).toHaveLength(1);
    const blocksText = JSON.stringify(slack.requests[0].body);
    expect(blocksText).toContain(
      'https://github.com/acme/widgets/actions/runs/4200'
    );
  });
});
