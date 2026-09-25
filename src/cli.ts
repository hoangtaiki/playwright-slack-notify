#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromFailedTests, type FailedTestLike } from './adapt.js';
import { summaryFromReport, type RawPlaywrightReport } from './report.js';
import { detectBuildContext, mergeBuildContext } from './ci.js';
import { notify } from './notify.js';
import type { Transport } from './send.js';

function printUsage(): void {
  console.error(`Usage: playwright-slack-notify <report.json|-> [options]

Reads either a raw Playwright JSON report, or a FailedTest[]-shaped JSON
array (e.g. from playwright-report-analyzer, or any tool producing the same
shape - the recommended input for a sharded/merged run, see the README's
sharding recipe). Pass '-' to read from stdin.

Transport (one of):
  --webhook <url>        Post to a legacy incoming webhook
  --token <token>        Post via chat.postMessage (bot token)
  --channel <channel>    Required with --token; optional override with --webhook

Options:
  --username <name>      Override the posting bot's display name
  --icon-emoji <emoji>   Override the posting bot's icon, e.g. :robot_face:
  --render <mode>        'blocks' (default) or 'text'
  --always               Post even when nothing failed (default: on-failure)
  --max-tests <n>        Cap on how many failing tests are listed (default: 5)
  --dry-run              Build the message and print the result without sending
  --pretty               Pretty-print the JSON result

Exit codes: 0 = ran normally (even if the Slack post itself failed or was
skipped); 1 = missing/malformed input; 2 = bad arguments.`);
}

function readInput(pathOrDash: string): string {
  if (pathOrDash === '-') {
    // Synchronous stdin read: this CLI is meant for a shell pipe
    // (`playwright-report-analyzer merged.json | playwright-slack-notify -`),
    // and reading fd 0 directly avoids the complexity of an async stdin
    // stream just to support one flag.
    return readFileSync(0, 'utf-8');
  }
  return readFileSync(pathOrDash, 'utf-8');
}

/** @internal exported for testing */
export async function run(argv: string[]): Promise<number> {
  const args = [...argv];
  const inputArg = args.find(a => !a.startsWith('--'));
  if (!inputArg) {
    printUsage();
    return 2;
  }

  let webhookUrl: string | undefined;
  let token: string | undefined;
  let channel: string | undefined;
  let username: string | undefined;
  let iconEmoji: string | undefined;
  let render: 'blocks' | 'text' = 'blocks';
  let always = false;
  let maxTests: number | undefined;
  let dryRun = false;
  let pretty = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--webhook':
        webhookUrl = args[++i];
        break;
      case '--token':
        token = args[++i];
        break;
      case '--channel':
        channel = args[++i];
        break;
      case '--username':
        username = args[++i];
        break;
      case '--icon-emoji':
        iconEmoji = args[++i];
        break;
      case '--render': {
        const value = args[++i];
        if (value !== 'blocks' && value !== 'text') {
          console.error(
            `playwright-slack-notify: --render must be 'blocks' or 'text', got '${value}'`
          );
          return 2;
        }
        render = value;
        break;
      }
      case '--always':
        always = true;
        break;
      case '--max-tests': {
        const value = Number(args[++i]);
        if (!Number.isFinite(value) || value < 0) {
          console.error(
            'playwright-slack-notify: --max-tests must be a non-negative number'
          );
          return 2;
        }
        maxTests = value;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--pretty':
        pretty = true;
        break;
      default:
        break;
    }
  }

  if (!dryRun && !webhookUrl && !(token && channel)) {
    console.error(
      'playwright-slack-notify: pass --webhook <url>, or --token <token> --channel <channel>, or use --dry-run to preview the message'
    );
    return 2;
  }

  let raw: string;
  try {
    raw = readInput(inputArg);
  } catch (err) {
    console.error(
      `playwright-slack-notify: could not read '${inputArg}': ${(err as Error).message}`
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `playwright-slack-notify: '${inputArg}' is not valid JSON: ${(err as Error).message}`
    );
    return 1;
  }

  const summary = Array.isArray(parsed)
    ? fromFailedTests(parsed as FailedTestLike[])
    : summaryFromReport(parsed as RawPlaywrightReport);

  // Same auto-detected build link as the reporter surface - the CLI is
  // just as often invoked directly from a CI step (see the sharding
  // recipe), so it gets the same zero-config build link.
  const build = mergeBuildContext(detectBuildContext(), summary.build);

  const transport: Transport = webhookUrl
    ? { webhookUrl, channel, username, iconEmoji }
    : token && channel
      ? { token, channel, username, iconEmoji }
      : // dry-run with no transport flags: a syntactically valid placeholder
        // so URL.canParse succeeds and the payload can still be shaped.
        { webhookUrl: 'https://hooks.slack.com/services/PLACEHOLDER' };

  const result = await notify(
    build ? { ...summary, build } : summary,
    transport,
    {
      sendResults: always ? 'always' : 'on-failure',
      render,
      maxTests,
      dryRun,
    }
  );

  console.log(JSON.stringify(result, null, pretty ? 2 : undefined));
  return 0;
}

/**
 * Whether this module is the process entrypoint.
 *
 * Comparing `import.meta.url` to `file://${process.argv[1]}` is NOT enough.
 * npm installs a `bin` as a symlink in `node_modules/.bin`, so `argv[1]` is
 * the symlink while `import.meta.url` is the resolved real path - they never
 * match, and the CLI exits 0 having done nothing. The naive form also
 * mangles paths containing spaces or other characters that need URL
 * encoding.
 *
 * @internal exported for testing
 */
export function isEntrypoint(
  argv1: string | undefined,
  moduleUrl: string
): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    // argv[1] is not a resolvable path (a REPL, an eval, a deleted file).
    return false;
  }
}

/* c8 ignore start */
if (isEntrypoint(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
}
/* c8 ignore stop */
