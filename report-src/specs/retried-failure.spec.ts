import { test } from '@playwright/test';

// Fails on every attempt under the config's retries: 1, so this ends up a
// genuine hard failure (TestCase.outcome() === 'unexpected') with retries: 1
// - two attempts, not a flaky test that eventually passed.
test('RETRY-01: fails on every attempt, a real retried hard failure', () => {
  throw new Error('this always fails, regardless of attempt');
});
