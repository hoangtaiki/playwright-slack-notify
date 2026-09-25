# Customization & Reference

This page covers everything the [README](../README.md) leaves out: every option, full control over
the message layout, the complete CLI flag list, and how the package is tested. Start with the
README if you just want a first message posted - come here once you want to change how it looks or
when it posts.

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

### The build link

`build.buildUrl` (and `job`/`buildNumber`/`author`/`commit`) are filled in automatically under
GitHub Actions or Jenkins - no `build` option needed on either provider. Pass `build` yourself to
override any of those fields, to add `reportUrl` (never auto-detected, since it depends on where
your own CI publishes the report), or to support a different CI provider:

```ts
[
  'playwright-slack-notify/reporter',
  {
    webhookUrl: process.env.SLACK_WEBHOOK,
    build: { reportUrl: process.env.REPORT_URL },
  },
];
```

`detectBuildContext(env?)` and `mergeBuildContext(detected, explicit)` are also exported directly,
if you want to see what was detected or reuse the same merge behaviour elsewhere.

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
