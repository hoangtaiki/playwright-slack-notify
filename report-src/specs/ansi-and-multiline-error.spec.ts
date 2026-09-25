import { test } from '@playwright/test';

// Playwright error messages routinely carry ANSI colour codes when the
// runner's own color detection is on; whether that happens here depends on
// the environment this suite is generated in (a non-TTY pipe usually
// disables it), so the color codes are embedded directly in a thrown Error
// instead. This is still a REAL failure a real Playwright run reports - only
// the error message's content is authored, the same way any test's
// assertion message is - not a hand-authored REPORT.
const RED = '\u001b[31m';
const RESET = '\u001b[39m';
const BOLD = '\u001b[1m';

test('ANSI-01: fails with an ANSI-coded, multi-line assertion dump', () => {
  throw new Error(
    [
      `${BOLD}${RED}Expected substring: "seeker.balance"${RESET}`,
      `${RED}Received string:    "seeker.credit_limit"${RESET}`,
      '',
      '    at handler (checkout.ts:42:11)',
      '    at process (checkout.ts:18:5)',
    ].join('\n')
  );
});
