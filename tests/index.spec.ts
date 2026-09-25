import { test, expect } from '@playwright/test';
import * as pkg from '../src/index.js';

test.describe('index - public barrel', () => {
  test('exports every documented public function', () => {
    const fns = [
      'buildMessage',
      'buildMessageAsync',
      'send',
      'notify',
      'fromFailedTests',
      'summaryFromReport',
      'assertWithinLimits',
    ];
    for (const name of fns) {
      expect(typeof (pkg as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
