import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './support/slack-server.js';
import { run, isEntrypoint } from '../src/cli.js';
import { RAW_REPORT_PATH, scratchPath } from './support/reports.js';
import { realRunSummary } from './support/failures.js';

function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => out.push(args.join(' '));
  console.error = (...args: unknown[]) => err.push(args.join(' '));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

test.describe('cli - arguments', () => {
  test('no input path prints usage and exits 2', async () => {
    const cap = captureConsole();
    const code = await run([]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('Usage:');
  });

  test('no transport and no --dry-run exits 2 with a clear message', async () => {
    const cap = captureConsole();
    const code = await run([RAW_REPORT_PATH]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('--dry-run');
  });

  test('an invalid --render value exits 2', async () => {
    const cap = captureConsole();
    const code = await run([RAW_REPORT_PATH, '--dry-run', '--render', 'bogus']);
    cap.restore();
    expect(code).toBe(2);
  });

  test('a negative --max-tests exits 2', async () => {
    const cap = captureConsole();
    const code = await run([RAW_REPORT_PATH, '--dry-run', '--max-tests', '-1']);
    cap.restore();
    expect(code).toBe(2);
  });

  test('a missing file exits 1', async () => {
    const cap = captureConsole();
    const code = await run([scratchPath('does-not-exist.json'), '--dry-run']);
    cap.restore();
    expect(code).toBe(1);
  });

  test('malformed JSON exits 1', async () => {
    const badPath = scratchPath('not-json.json');
    fs.writeFileSync(badPath, 'this is not json');
    const cap = captureConsole();
    const code = await run([badPath, '--dry-run']);
    cap.restore();
    expect(code).toBe(1);
  });
});

test.describe('cli - real report input', () => {
  test('a real raw report with real failures, --dry-run, reports reason: dry-run and a payload', async () => {
    const cap = captureConsole();
    const code = await run([RAW_REPORT_PATH, '--dry-run', '--max-tests', '3']);
    cap.restore();
    expect(code).toBe(0);
    const result = JSON.parse(cap.out.join(''));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('dry-run');
    expect(result.payload).toBeDefined();
  });

  test('an empty (zero-failure) report under the default on-failure mode is skipped as "nothing-to-report", with no payload', async () => {
    const emptyPath = scratchPath('empty-report.json');
    fs.writeFileSync(
      emptyPath,
      JSON.stringify({
        suites: [],
        errors: [],
        stats: {
          startTime: '',
          duration: 0,
          expected: 0,
          unexpected: 0,
          flaky: 0,
          skipped: 0,
        },
      })
    );
    const cap = captureConsole();
    const code = await run([emptyPath, '--dry-run']);
    cap.restore();
    expect(code).toBe(0);
    const result = JSON.parse(cap.out.join(''));
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('nothing-to-report');
    expect(result.payload).toBeUndefined();
  });

  test('--always forces a post-shaped dry run even on an empty report', async () => {
    const emptyPath = scratchPath('empty-report-2.json');
    fs.writeFileSync(emptyPath, JSON.stringify({ suites: [], errors: [] }));
    const cap = captureConsole();
    const code = await run([emptyPath, '--dry-run', '--always']);
    cap.restore();
    expect(code).toBe(0);
    const result = JSON.parse(cap.out.join(''));
    expect(result.reason).toBe('dry-run');
    expect(result.payload).toBeDefined();
  });

  test('a FailedTest[]-shaped array (e.g. the documented sharding input from playwright-report-analyzer) is accepted directly', async () => {
    const failedPath = scratchPath('failed-tests.json');
    fs.writeFileSync(failedPath, JSON.stringify(realRunSummary().failures));
    const cap = captureConsole();
    const code = await run([failedPath, '--dry-run']);
    cap.restore();
    expect(code).toBe(0);
    const result = JSON.parse(cap.out.join(''));
    expect(result.reason).toBe('dry-run');
  });

  test('reads from real stdin when given "-" - the actual shell-pipe path, against the built CLI', () => {
    const builtCli = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
    test.skip(!fs.existsSync(builtCli), 'run `npm run build` first');
    const output = execFileSync(
      process.execPath,
      [builtCli, '-', '--dry-run'],
      {
        input: JSON.stringify(realRunSummary().failures),
        encoding: 'utf-8',
      }
    );
    const result = JSON.parse(output);
    expect(result.reason).toBe('dry-run');
  });

  test('--pretty pretty-prints the JSON result', async () => {
    const cap = captureConsole();
    await run([RAW_REPORT_PATH, '--dry-run', '--pretty']);
    cap.restore();
    expect(cap.out.join('')).toContain('\n  "ok"');
  });
});

test.describe('cli - a real post via --webhook', () => {
  test('an actual send happens against the loopback server when --webhook is given', async ({
    slack,
  }) => {
    slack.respondWith({ status: 200, body: 'ok' });
    const cap = captureConsole();
    const code = await run([
      RAW_REPORT_PATH,
      '--webhook',
      slack.url,
      '--max-tests',
      '2',
    ]);
    cap.restore();
    expect(code).toBe(0);
    expect(slack.requests).toHaveLength(1);
    const result = JSON.parse(cap.out.join(''));
    expect(result.ok).toBe(true);
  });
});

test.describe('isEntrypoint', () => {
  test('matches when argv[1] resolves to this module', () => {
    const modulePath = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
    if (!fs.existsSync(modulePath))
      test.skip(true, 'run `npm run build` first');
    expect(
      isEntrypoint(modulePath, pathToFileURL(fs.realpathSync(modulePath)).href)
    ).toBe(true);
  });

  test('does not match a symlink to a DIFFERENT file, proving realpath resolution matters (the npm bin symlink bug)', () => {
    const real = scratchPath('real-target.js');
    const link = scratchPath('symlink-to-real.js');
    fs.writeFileSync(real, '// real file\n');
    fs.rmSync(link, { force: true });
    try {
      fs.symlinkSync(real, link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      test.skip(
        code === 'EPERM' || code === 'EACCES',
        `cannot create a symlink on this platform (${code})`
      );
      throw err;
    }
    // The link resolves to `real`, so comparing it against a DIFFERENT
    // module's URL must not match.
    expect(
      isEntrypoint(link, pathToFileURL('/some/other/module.js').href)
    ).toBe(false);
    // But comparing it against `real`s own URL must match - this is exactly
    // the npm `node_modules/.bin` symlink scenario.
    expect(isEntrypoint(link, pathToFileURL(fs.realpathSync(real)).href)).toBe(
      true
    );
  });

  test('returns false for an unresolvable path rather than throwing', () => {
    expect(
      isEntrypoint('/definitely/does/not/exist.js', pathToFileURL('/x.js').href)
    ).toBe(false);
  });

  test('returns false when argv[1] is undefined (a REPL)', () => {
    expect(isEntrypoint(undefined, pathToFileURL('/x.js').href)).toBe(false);
  });
});
