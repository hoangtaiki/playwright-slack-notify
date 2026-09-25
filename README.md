# Playwright Slack Notify

<div align="center">

[![npm version](https://img.shields.io/npm/v/playwright-slack-notify.svg)](https://www.npmjs.com/package/playwright-slack-notify)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/hoangtaiki/playwright-slack-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/hoangtaiki/playwright-slack-notify/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/hoangtaiki/playwright-slack-notify/branch/main/graph/badge.svg)](https://codecov.io/gh/hoangtaiki/playwright-slack-notify)
[![Downloads](https://img.shields.io/npm/dt/playwright-slack-notify.svg)](https://www.npmjs.com/package/playwright-slack-notify)

**Post Playwright test results to Slack - a reporter, a library and a CLI, with zero runtime dependencies**

</div>

A Playwright `Reporter` that posts a Block Kit message from `onEnd()` - real
Playwright's own "afterAll" hook, awaited, so the post completes before the
run exits. Also works as a plain library (`buildMessage`, `send`, `notify`)
and a CLI, for a sharded run where no single process sees every result.

Zero runtime dependencies. No other Playwright package is required, or even
useful, at runtime - the reporter builds its message from the live test run,
the CLI reads a plain Playwright JSON report on its own.

## The Problem

The usual way teams post Playwright results to Slack is a hand-built `curl`
string in a CI script:

```groovy
def failedMessage = "curl -X POST --data-urlencode 'payload={\"channel\": \"#ci-test-builds\", " +
    "\"username\": \"CI Bot\", " +
    "\"text\": \"*'${config.subdomain}'* - ${config.buildName} - ${config.mrUser} - " +
    "Build Failure '${env.BUILD_NUMBER}' - <'${env.BUILD_URL}'|build>\", " +
    "\"icon_emoji\": \":red_circle:\"}' ${SLACK_WEBHOOK}"
```

This tells you the build failed. It does not tell you **what** failed - the
message is a fixed template of subdomain/build-number/link, built before any
test even runs. Sixteen near-identical copies of this string exist across
four CI scripts, none of them lists a single failing test name, none of them
retries a dropped connection, and the webhook is one hardcoded live
credential shared by all of them.

## The Solution

Register a reporter. It walks the real test run, groups failures by file,
truncates safely (no broken `*bold*` pairs, no literal `<tags>` rendering as
markup, no Block Kit limit ever exceeded), and posts once, with retry and
backoff, from the one place in Playwright that is guaranteed to run exactly
once per invocation regardless of workers or shards.

```
:red_circle:  CHROME P1 - Build Failure
main-develop-26505 · #412 · hoang · 2m 14s · <build> · <report>
17 failed · 1 flaky · 128 passed · 4 skipped

*specs/checkout.spec.ts*
:x: *CBRO-02: seeker cannot browse*  `chrome`  ×2
     expect(locator).toBeVisible() failed
:x: *CAM2-03: chat price not applied*  `chrome`

… and 12 more
```

## Quick Start

### Requirements

- Node.js >= 20
- `@playwright/test` >= 1.40 (optional peer dependency - only needed for the
  reporter surface; the library and CLI need nothing Playwright-specific)

### As a reporter

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['list'],
    [
      'playwright-slack-notify/reporter',
      {
        webhookUrl: process.env.SLACK_WEBHOOK,
        sendResults: 'on-failure', // default: see sendResults in the API section
        meta: [{ key: 'Branch', value: process.env.BRANCH_NAME ?? '' }],
        build: { job: 'main-develop-26505', buildUrl: process.env.BUILD_URL },
      },
    ],
  ],
});
```

### As a CLI, for a sharded run

A reporter registered under `--shard` posts once **per shard**. For one
message covering the whole run, turn the reporter off on shards and post
once after merging:

```sh
# On each shard
npx playwright test --shard=1/4 --reporter=json,blob

# After merging
npx playwright merge-reports --reporter=json ./blob-report > merged.json
npx playwright-slack-notify merged.json --webhook "$SLACK_WEBHOOK"
```

It also accepts a `FailedTest[]`-shaped JSON array directly - the shape
[`playwright-report-analyzer`](https://www.npmjs.com/package/playwright-report-analyzer)
(or any tool producing the same shape) emits, which correctly collapses the
duplicate spec entries a rerun-then-merge can produce:

```sh
npx playwright-report-analyzer merged.json | npx playwright-slack-notify -
```

### As a library

```ts
import { buildMessage, send } from 'playwright-slack-notify';

const message = buildMessage(summary, { maxTests: 10 });
const result = await send(message, { webhookUrl: process.env.SLACK_WEBHOOK! });
```

## Compared to `playwright-slack-report`

[`playwright-slack-report`](https://www.npmjs.com/package/playwright-slack-report)
is the established package for this. Where this one differs:

|                                                            | playwright-slack-notify                                    | playwright-slack-report          |
| ---------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| Runtime dependencies                                       | none                                                       | `@slack/web-api`                 |
| Legacy webhook `channel`/`username`/`icon_emoji` overrides | supported                                                  | not supported (app-webhook only) |
| Sharded / merged reports                                   | a first-class CLI path                                     | a named open limitation          |
| Bot token (`chat.postMessage`)                             | supported                                                  | supported                        |
| Custom layout                                              | `layout`/`layoutAsync`, given the default blocks to extend | `layout`/`layoutAsync`           |

## CLI

```
Usage: playwright-slack-notify <report.json|-> [options]

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
skipped); 1 = missing/malformed input; 2 = bad arguments.
```

## API

### `SlackNotifyReporter` (default export of `playwright-slack-notify/reporter`)

Options (all optional except a transport):

| Option                             | Default        |                                                                          |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `webhookUrl` / `token` + `channel` | -              | one is required                                                          |
| `sendResults`                      | `'on-failure'` | `'always'` \| `'on-failure'` \| `'off'`                                  |
| `header`                           | auto           | `string \| false \| (summary) => string`                                 |
| `text`                             | auto           | the notification fallback line                                           |
| `meta`                             | -              | `{key, value}[]` rows (branch, ticket, environment, ...)                 |
| `footer`                           | -              | extra Block Kit blocks appended after the failure list                   |
| `groupBy`                          | `'file'`       | `'file'` \| `'project'` \| `'none'`                                      |
| `titleStyle`                       | `'own'`        | `'own'` \| `'full'` \| `'path'` - see below                              |
| `maxTests`                         | `5`            | how many failing/flaky tests are listed                                  |
| `maxTitleChars` / `maxErrorChars`  | `160` / `200`  | `false` disables cosmetic truncation (the hard Slack limits still apply) |
| `sourceUrl`                        | -              | `(test) => string \| undefined`, linked from each test line              |
| `notifyOnFlaky`                    | `true`         | whether a flaky-only run still posts                                     |
| `unfurlLinks` / `unfurlMedia`      | `false`        | Slack link preview behaviour                                             |
| `layout` / `layoutAsync`           | -              | `(summary, defaults) => Block[]`, full control                           |

`titleStyle` matters for a nested `describe` block: a `FailedTest.title` is
the **whole** path joined by `' > '`, so a deeply nested scenario can run
past 200 characters before any error text is added. `'own'` (default) shows
only the test's own title, with the file (or project) as a group heading
instead of repeating the path on every line.

### `buildMessage(summary, options?)` / `buildMessageAsync(summary, options?)`

Builds a `{ text, blocks, warnings }` object. `buildMessage` throws if
`options.layoutAsync` is given - use `buildMessageAsync` (or `notify`, which
always does) for that.

### `send(message, transport, options?)`

Posts to a `WebhookTransport` (`{ webhookUrl, channel?, username?,
iconEmoji?, iconUrl? }`) or a `BotTokenTransport` (`{ token, channel,
threadTs?, ... }`). Never throws - every outcome, including a network
failure or an invalid URL, comes back as a `SendResult` with a closed set of
`code`s (`http_error`, `rate_limited`, `timeout`, `network_error`,
`invalid_url`, `aborted`). Retries with equal-jitter backoff, honours a
`Retry-After` header (clamped so a rate-limited CI job cannot sleep for an
hour), and `dryRun: true` returns the exact payload without sending it.

**The webhook URL never appears in a result, a thrown error, or a log
line** - see "How it is tested" below.

### `notify(summary, transport, options?)`

`buildMessageAsync` + `send`, gated by `sendResults`. What the reporter and
the CLI both call.

### `fromFailedTests(failed, options?)` / `fromAnalysis(analysis, options?)`

Structural adapters from a `FailedTest[]`-shaped array (or an
`analyze()`-shaped `{ summary, failed }`) into this package's `RunSummary`.
Generic bridges, not a dependency on any one producer - anything with the
same shape works. Every field is optional except `title`, so a minimal
`{ title: 'a.spec.ts > t' }` is already valid input.

### `summaryFromReport(report)`

Reads a raw Playwright JSON report directly into a `RunSummary`, with no
other package involved. Deliberately simpler than a dedicated analyzer: it
does not collapse the duplicate spec entries a rerun-then-merge can produce
(see the CLI section above for that case) - it covers the plain, single-run
report this package's own reporter surface never needs at all.

## How it is tested

Every test asserts against a **real** Playwright report, produced by really
running Playwright in `globalSetup` on every `npm test` - never a hand-authored
snapshot, so a Playwright upgrade that changes the report schema fails the
build here instead of silently passing. The report includes a genuinely long,
special-character title, real ANSI-coded multi-line errors, a real timeout,
and a real retried failure, across two real projects.

HTTP behaviour (retries, rate limiting, timeouts, and the requirement that
the webhook URL can never leak through a result or a thrown error) is proven
against a real loopback `node:http` server, not a mock library. The reporter
itself is proven by running a **second, real Playwright process** against
that same server and asserting on what it actually received.

This package has no dependency, dev or otherwise, on any other Playwright
utility package - not even in its own tests.

## License

MIT (c) Harry Tran
