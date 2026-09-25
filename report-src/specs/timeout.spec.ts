import { test } from '@playwright/test';

// A real 'timedOut' status, kept fast (1s) rather than waiting on the
// suite's default timeout, since this runs twice (config retries: 1) across
// two projects.
test('TIMEOUT-01: exceeds its timeout on every attempt', async () => {
  test.setTimeout(1_000);
  await new Promise(() => {
    /* never resolves */
  });
});
