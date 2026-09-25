import { test, expect } from '@playwright/test';
import { buildMessage, buildMessageAsync } from '../src/message.js';
import { assertWithinLimits, type Block } from '../src/blocks.js';
import type { RunSummary, TestOutcome } from '../src/model.js';
import { realRunSummary } from './support/failures.js';

function allText(blocks: readonly Block[]): string {
  return blocks
    .map(b => {
      if (b.type === 'section')
        return [b.text?.text, ...(b.fields ?? []).map(f => f.text)]
          .filter(Boolean)
          .join('\n');
      if (b.type === 'header') return b.text.text;
      if (b.type === 'context') return b.elements.map(e => e.text).join('\n');
      return '';
    })
    .join('\n');
}

test.describe('buildMessage - real report data', () => {
  test('produces a message within every Slack limit', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary);
    expect(() => assertWithinLimits(built)).not.toThrow();
  });

  test('the default maxTests of 5 caps the list and reports the remainder', () => {
    const summary = realRunSummary();
    expect(summary.failed).toBeGreaterThan(5); // report-src has 10 real failures
    const built = buildMessage(summary);
    const text = allText(built.blocks);
    expect(text).toMatch(/and \d+ more/);
  });

  test('raising maxTests shows more entries and eventually all of them', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100 });
    const text = allText(built.blocks);
    expect(text).not.toMatch(/and \d+ more/);
    expect(() => assertWithinLimits(built)).not.toThrow();
  });

  test('maxTests: 0 posts counts only, no test list', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 0 });
    const text = allText(built.blocks);
    expect(text).not.toContain(':x:');
  });

  test('real special-character title renders with no raw unescaped < or literal >, and stays valid', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, titleStyle: 'own' });
    expect(() => assertWithinLimits(built)).not.toThrow();
    const text = allText(built.blocks);
    // The real title has literal <tags> and & - both must be escaped.
    expect(text).not.toContain('<tags>');
    expect(text).toContain('&lt;tags&gt;');
    expect(text).toContain('&amp;');
  });

  test("titleStyle 'own' shows only the test's own title, factored out of the file heading", () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, titleStyle: 'own' });
    const text = allText(built.blocks);
    expect(text).toContain('SIMPLE-01: an ordinary short failure');
    expect(text).toContain('simple-failure.spec.ts');
  });

  test("titleStyle 'full' shows the whole joined path on the test line itself", () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, titleStyle: 'full' });
    const text = allText(built.blocks);
    expect(text).toContain('simple-failure.spec.ts &gt; SIMPLE-01');
  });

  test("groupBy 'project' groups by project name instead of file", () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, groupBy: 'project' });
    const text = allText(built.blocks);
    expect(text).toContain('project-a');
    expect(text).toContain('project-b');
  });

  test("groupBy 'none' emits no group headings at all", () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, groupBy: 'none' });
    const text = allText(built.blocks);
    expect(text).not.toContain('*simple-failure.spec.ts*');
  });

  test('the status section reports build context and counts', () => {
    const summary: RunSummary = {
      ...realRunSummary(),
      build: { job: 'main-develop-26505', buildNumber: 412, author: 'hoang' },
    };
    const built = buildMessage(summary);
    const text = allText(built.blocks);
    expect(text).toContain('main-develop-26505');
    expect(text).toContain('#412');
    expect(text).toContain('hoang');
    expect(text).toContain('10 failed');
  });

  test('sourceUrl renders a real file:line link on each test line', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, {
      maxTests: 100,
      sourceUrl: t =>
        t.file ? `https://github.com/org/repo/blob/main/${t.file}` : undefined,
    });
    const text = allText(built.blocks);
    expect(text).toContain(
      '<https://github.com/org/repo/blob/main/simple-failure.spec.ts|simple-failure.spec.ts:5>'
    );
  });

  test('retried real failures show an attempt-count badge', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100 });
    const text = allText(built.blocks);
    // Every real failure here has retries: 1 (config-wide retries: 1) -> ×2.
    expect(text).toContain('×2');
  });

  test('a real ANSI-coded, multi-line error is normalised before rendering', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, showErrors: true });
    const text = allText(built.blocks);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('Expected substring');
  });

  test('showErrors: false omits the error line entirely', () => {
    const summary = realRunSummary();
    const built = buildMessage(summary, { maxTests: 100, showErrors: false });
    const text = allText(built.blocks);
    expect(text).not.toContain('Expected substring');
  });
});

test.describe('buildMessage - links', () => {
  const baseSummary: RunSummary = {
    outcome: 'failed',
    passed: 0,
    failed: 1,
    flaky: 0,
    skipped: 0,
    failures: [{ title: 'a.spec.ts > t', titlePath: ['a.spec.ts', 't'] }],
  };

  test('a valid buildUrl and reportUrl render as real Slack links', () => {
    const built = buildMessage({
      ...baseSummary,
      build: {
        job: 'j',
        buildUrl: 'https://ci.example.com/412',
        reportUrl: 'https://ci.example.com/report',
      },
    });
    const text = allText(built.blocks);
    expect(text).toContain('<https://ci.example.com/412|build>');
    expect(text).toContain('<https://ci.example.com/report|report>');
  });

  test('a buildUrl containing | degrades to plain text rather than a half-formed link', () => {
    const built = buildMessage({
      ...baseSummary,
      build: { job: 'j', buildUrl: 'https://ci.example.com/a|b' },
    });
    const text = allText(built.blocks);
    expect(text).not.toContain('<https://ci.example.com/a|b|build>');
    expect(text).not.toMatch(/<https:\/\/ci\.example\.com\/a\|/);
  });

  test('a buildUrl containing > degrades to plain text', () => {
    const built = buildMessage({
      ...baseSummary,
      build: { job: 'j', buildUrl: 'https://ci.example.com/a>b' },
    });
    const text = allText(built.blocks);
    expect(text).not.toContain('<https://ci.example.com/a>b|build>');
  });

  test('links never appear in the header (plain_text does not parse mrkdwn)', () => {
    const built = buildMessage(
      {
        ...baseSummary,
        build: { job: 'j', buildUrl: 'https://ci.example.com/412' },
      },
      { header: 'Build <https://ci.example.com/412|link>' }
    );
    const headerBlock = built.blocks.find(b => b.type === 'header');
    expect(headerBlock?.type).toBe('header');
    if (headerBlock?.type === 'header') {
      expect(headerBlock.text.text).not.toContain('<');
      expect(headerBlock.text.text).not.toContain('>');
    }
  });
});

test.describe('buildMessage - report errors and meta', () => {
  const baseSummary: RunSummary = {
    outcome: 'failed',
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    failures: [],
  };

  test('report errors render even with zero failed tests', () => {
    const built = buildMessage({
      ...baseSummary,
      reportErrors: [{ message: 'Cannot find module "./missing.js"' }],
    });
    const text = allText(built.blocks);
    expect(text).toContain('Cannot find module');
  });

  test('meta rows render as fields', () => {
    const built = buildMessage({
      ...baseSummary,
      meta: [{ key: 'Branch', value: 'nf-26505' }],
    });
    const text = allText(built.blocks);
    expect(text).toContain('Branch');
    expect(text).toContain('nf-26505');
  });
});

test.describe('buildMessage - block budgeting backstop', () => {
  const manyFailures: TestOutcome[] = Array.from({ length: 300 }, (_, i) => ({
    title: `f${i}.spec.ts > test ${i}`,
    titlePath: [`f${i}.spec.ts`, `test ${i}`],
  }));

  test('a huge maxTests with hundreds of failures never exceeds Slacks block limit', () => {
    const summary: RunSummary = {
      outcome: 'failed',
      passed: 0,
      failed: manyFailures.length,
      flaky: 0,
      skipped: 0,
      failures: manyFailures,
    };
    const built = buildMessage(summary, { maxTests: 10_000 });
    expect(() => assertWithinLimits(built)).not.toThrow();
  });

  test('a large caller-supplied footer that would overflow the frame is dropped whole, never truncated', () => {
    const bigFooter: Block[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: `footer ${i}` },
    }));
    const summary: RunSummary = {
      outcome: 'failed',
      passed: 0,
      failed: 1,
      flaky: 0,
      skipped: 0,
      failures: [{ title: 'a.spec.ts > t', titlePath: ['a.spec.ts', 't'] }],
    };
    const built = buildMessage(summary, { footer: bigFooter });
    expect(() => assertWithinLimits(built)).not.toThrow();
    expect(built.warnings.length).toBeGreaterThan(0);
  });
});

test.describe('buildMessage - silence-adjacent building blocks', () => {
  test('zero failures still produces a valid message (silence itself is notify()s job, not buildMessages)', () => {
    const summary: RunSummary = {
      outcome: 'passed',
      passed: 5,
      failed: 0,
      flaky: 0,
      skipped: 0,
      failures: [],
    };
    const built = buildMessage(summary);
    expect(() => assertWithinLimits(built)).not.toThrow();
  });

  test('flaky-only tests render with a warning icon, not a failure icon', () => {
    const summary: RunSummary = {
      outcome: 'passed',
      passed: 5,
      failed: 0,
      flaky: 1,
      skipped: 0,
      failures: [],
      flakyTests: [
        {
          title: 'a.spec.ts > t',
          titlePath: ['a.spec.ts', 't'],
          status: 'flaky',
        },
      ],
    };
    const built = buildMessage(summary);
    const text = allText(built.blocks);
    expect(text).toContain(':warning:');
    expect(text).not.toContain(':x:');
  });

  test('notifyOnFlaky: false excludes flaky tests from the rendered list', () => {
    const summary: RunSummary = {
      outcome: 'passed',
      passed: 5,
      failed: 0,
      flaky: 1,
      skipped: 0,
      failures: [],
      flakyTests: [
        {
          title: 'a.spec.ts > flaky-one',
          titlePath: ['a.spec.ts', 'flaky-one'],
          status: 'flaky',
        },
      ],
    };
    const built = buildMessage(summary, { notifyOnFlaky: false });
    const text = allText(built.blocks);
    expect(text).not.toContain('flaky-one');
  });
});

test.describe('buildMessage - custom layout', () => {
  const summary: RunSummary = {
    outcome: 'failed',
    passed: 0,
    failed: 1,
    flaky: 0,
    skipped: 0,
    failures: [{ title: 'a.spec.ts > t', titlePath: ['a.spec.ts', 't'] }],
  };

  test('layout receives the default blocks and can splice one extra block in', () => {
    const built = buildMessage(summary, {
      layout: (_s, defaults) => [
        defaults.status,
        { type: 'section', text: { type: 'mrkdwn', text: 'injected' } },
        ...defaults.failures,
      ],
    });
    const text = allText(built.blocks);
    expect(text).toContain('injected');
    expect(() => assertWithinLimits(built)).not.toThrow();
  });

  test('a hostile layout returning 200 tiny blocks still comes back valid, with warnings', () => {
    const built = buildMessage(summary, {
      layout: () =>
        Array.from({ length: 200 }, (_, i) => ({
          type: 'section' as const,
          text: { type: 'mrkdwn' as const, text: `b${i}` },
        })),
    });
    expect(() => assertWithinLimits(built)).not.toThrow();
    expect(built.warnings.length).toBeGreaterThan(0);
  });

  test('buildMessage throws if layoutAsync is given - it needs buildMessageAsync', () => {
    expect(() =>
      buildMessage(summary, { layoutAsync: async (_s, d) => d.blocks })
    ).toThrow();
  });

  test('buildMessageAsync awaits layoutAsync', async () => {
    const built = await buildMessageAsync(summary, {
      layoutAsync: async (_s, defaults) => {
        await new Promise(r => setTimeout(r, 1));
        return [...defaults.blocks, { type: 'divider' }];
      },
    });
    expect(built.blocks.at(-1)?.type).toBe('divider');
  });

  test('buildMessageAsync with no layout at all behaves like buildMessage', async () => {
    const sync = buildMessage(summary);
    const async_ = await buildMessageAsync(summary);
    expect(async_.blocks).toEqual(sync.blocks);
    expect(async_.text).toEqual(sync.text);
  });
});
