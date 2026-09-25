# Playwright Slack Notify

<div align="center">

[![npm version](https://img.shields.io/npm/v/playwright-slack-notify.svg)](https://www.npmjs.com/package/playwright-slack-notify)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/hoangtaiki/playwright-slack-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/hoangtaiki/playwright-slack-notify/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/hoangtaiki/playwright-slack-notify/branch/main/graph/badge.svg)](https://codecov.io/gh/hoangtaiki/playwright-slack-notify)
[![Downloads](https://img.shields.io/npm/dt/playwright-slack-notify.svg)](https://www.npmjs.com/package/playwright-slack-notify)

**Post your Playwright test results to Slack - a few lines of setup, no extra service required**

</div>

Add this to your Playwright config and every test run posts a Slack message: how many tests
passed, which ones failed, and a link back to the build. All you need is a Slack webhook URL - no
extra dependencies, no separate service to run.

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

The build link is automatic on GitHub Actions and Jenkins. The report link is optional - it's there
because a link to the actual test report page is genuinely useful, but since that page lives
wherever your own CI publishes it, you tell the package where to find it (see
[Customization & Reference](docs/CUSTOMIZATION.md)).

## Getting a Slack webhook URL

In Slack, go to **Apps → Incoming Webhooks** (or ask your workspace admin), add a webhook for the
channel you want, and copy the URL it gives you. That's the only piece of setup this needs.

## Quick Start

### As a reporter

Add it to your Playwright config with your webhook URL, and it posts automatically at the end of
every run:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [['list'], ['playwright-slack-notify/reporter', { webhookUrl: process.env.SLACK_WEBHOOK }]],
});
```

By default it only posts when something failed or is flaky, and only lists the first 5 failing
tests. If you're running in GitHub Actions or Jenkins, the build link shown above is added
automatically - nothing else to configure. On another CI provider, or if you also publish an HTML
report, you can add those links yourself (see [Customization & Reference](docs/CUSTOMIZATION.md)).

### If your tests run in parallel shards

A reporter posts once per shard, which means one Slack message per shard instead of one for the
whole run. If you shard your tests, merge the reports first and post once at the end:

```sh
# On each shard
npx playwright test --shard=1/4 --reporter=json,blob

# After merging
npx playwright merge-reports --reporter=json ./blob-report > merged.json
npx playwright-slack-notify merged.json --webhook "$SLACK_WEBHOOK"
```

### As a library

If you'd rather build and send the message yourself (for example, from your own script):

```ts
import { buildMessage, send } from 'playwright-slack-notify';

const message = buildMessage(summary);
const result = await send(message, { webhookUrl: process.env.SLACK_WEBHOOK! });
```

## Requirements

- Node.js >= 20
- `@playwright/test` >= 1.40, only if you're using the reporter

## Want more?

Every option (custom message layout, which tests get shown, posting via a Slack bot token instead
of a webhook, the full CLI reference, and how this package is tested) is documented in
[Customization & Reference](docs/CUSTOMIZATION.md).

## License

MIT (c) Harry Tran
