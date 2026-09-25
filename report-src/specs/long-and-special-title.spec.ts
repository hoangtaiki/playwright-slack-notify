import { test, expect } from '@playwright/test';

// A title that is, on its own (titleStyle: 'own' takes only this, the test's
// own title - never the describe/file path), well past 160 characters, and
// that contains every character this package's mrkdwn escaping and code-span
// rules have to handle correctly: & < > * _ ` and an emoji. Real Playwright
// output, not a hand-authored fixture - the title is just a long string, and
// Playwright reports it verbatim.
const LONG_SPECIAL_TITLE =
  'LONG-01: a scenario whose own title contains <tags> & ampersands & *asterisks* and _underscores_ plus a `backtick` and an emoji 🎉, deliberately padded well past one hundred and sixty characters so truncation is exercised on REAL Playwright output';

test(LONG_SPECIAL_TITLE, () => {
  expect(LONG_SPECIAL_TITLE.length).toBeGreaterThan(160);
  expect(1, 'this scenario is meant to fail').toBe(2);
});
