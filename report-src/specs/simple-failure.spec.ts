import { test, expect } from '@playwright/test';

// An ordinary, short, unremarkable failure - the baseline case every
// grouping/rendering test compares the more exotic scenarios against.
test('SIMPLE-01: an ordinary short failure', () => {
  expect(1).toBe(2);
});
