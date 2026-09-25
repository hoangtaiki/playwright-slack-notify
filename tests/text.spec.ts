import { test, expect } from '@playwright/test';
import {
  escapeMrkdwn,
  fitEscaped,
  isValidSlackUrl,
  measureBytes,
  normalize,
  slackLink,
  truncate,
} from '../src/text.js';
import { findFailure } from './support/failures.js';

test.describe('measureBytes', () => {
  test('counts UTF-8 bytes, not JS string length', () => {
    expect(measureBytes('abc')).toBe(3);
    // An emoji is a surrogate pair in UTF-16 (length 2) but 4 UTF-8 bytes.
    expect(measureBytes('🎉')).toBe(4);
    expect('🎉').toHaveLength(2);
  });
});

test.describe('normalize', () => {
  test('strips real ANSI codes from a real Playwright error message', () => {
    const real = findFailure('ANSI-01');
    expect(real.error).toContain('\u001b[');
    const cleaned = normalize(real.error ?? '');
    expect(cleaned).not.toContain('\u001b');
    expect(cleaned).toContain('Expected substring');
  });

  test('collapses newlines and tabs to single spaces', () => {
    expect(normalize('a\nb\tc\r\nd')).toBe('a b c d');
  });

  test('collapses runs of spaces and trims', () => {
    expect(normalize('  a   b  ')).toBe('a b');
  });

  test('strips other C0 control characters', () => {
    expect(normalize('a\u0000b\u0007c')).toBe('abc');
  });
});

test.describe('truncate', () => {
  test('returns the input unchanged when it already fits', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  test('cuts on a grapheme boundary, never splitting an emoji', () => {
    const result = truncate('a🎉🎉🎉🎉🎉', 6);
    // Never contains a lone surrogate half.
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.endsWith('…')).toBe(true);
  });

  test('prefers a whitespace boundary near the cut over a mid-word chop', () => {
    // budget = maxBytes(13) - measureBytes('…')(3) = 10. The first 10
    // bytes of the raw string are 'abcdefghi ' (a trailing space at index
    // 9, the very last kept position) - within the final 20% of that 10-char
    // window, so the trailing space is trimmed rather than kept dangling
    // right before the ellipsis.
    const result = truncate('abcdefghi klmnop', 13);
    expect(result).toBe('abcdefghi…');
  });

  test('returns empty string when there is no room at all', () => {
    expect(truncate('anything', 0)).toBe('');
  });

  test('never exceeds the byte budget on real, long Playwright title data', () => {
    const real = findFailure('LONG-01');
    const result = truncate(real.title, 160);
    expect(measureBytes(result)).toBeLessThanOrEqual(160);
  });
});

test.describe('escapeMrkdwn', () => {
  test('escapes & first, then < and >', () => {
    expect(escapeMrkdwn('a & b')).toBe('a &amp; b');
    expect(escapeMrkdwn('<tag>')).toBe('&lt;tag&gt;');
    // If & were escaped after < / >, this would double-escape.
    expect(escapeMrkdwn('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });

  test('leaves *, _, ` and ~ untouched - Slack mrkdwn has no escape for them', () => {
    expect(escapeMrkdwn('*b* _i_ `c` ~s~')).toBe('*b* _i_ `c` ~s~');
  });

  test('every real title in report-src contains a literal > from the joined path, and it gets escaped', () => {
    const real = findFailure('SIMPLE-01');
    expect(real.title).toContain(' > ');
    expect(escapeMrkdwn(real.title)).toContain('&gt;');
  });
});

test.describe('fitEscaped', () => {
  test('fits a normal string with room to spare', () => {
    const result = fitEscaped('hello world', 100);
    expect(result).toBe('hello world');
    expect(measureBytes(result)).toBeLessThanOrEqual(100);
  });

  test('the escape-inflation guard: a raw string of pure & always stays within budget after escaping', () => {
    // & -> &amp; is 1 byte -> 5 bytes. truncate(raw, budget) alone would NOT
    // guarantee the escaped result fits - this is the regression test for
    // that exact defect.
    const raw = '&'.repeat(1000);
    const result = fitEscaped(raw, 200);
    expect(measureBytes(result)).toBeLessThanOrEqual(200);
    expect(result.length).toBeGreaterThan(0);
  });

  test('fits real report data containing many literal > separators', () => {
    const real = findFailure('LONG-01');
    const result = fitEscaped(real.title, 160);
    expect(measureBytes(result)).toBeLessThanOrEqual(160);
  });

  test('degrades to empty string rather than overflow when the budget is absurdly small', () => {
    const result = fitEscaped('&'.repeat(50), 1);
    expect(measureBytes(result)).toBeLessThanOrEqual(1);
  });
});

test.describe('isValidSlackUrl / slackLink', () => {
  test('accepts a plain https URL', () => {
    expect(isValidSlackUrl('https://example.com/build/412')).toBe(true);
  });

  test('rejects a URL containing a pipe, which would terminate <url|label> early', () => {
    expect(isValidSlackUrl('https://example.com/a|b')).toBe(false);
  });

  test('rejects a URL containing a >, which would inject markup', () => {
    expect(isValidSlackUrl('https://example.com/a>b')).toBe(false);
  });

  test('rejects a non-http(s) protocol', () => {
    expect(isValidSlackUrl('javascript:alert(1)')).toBe(false);
  });

  test('rejects an unparseable string', () => {
    expect(isValidSlackUrl('not a url')).toBe(false);
  });

  test('slackLink renders the real <url|label> syntax, never markdown [label](url)', () => {
    const link = slackLink('https://example.com/build/412', 'build');
    expect(link).toBe('<https://example.com/build/412|build>');
    expect(link).not.toContain('](');
  });

  test('slackLink degrades to plain escaped text when the url is invalid', () => {
    const link = slackLink('https://example.com/a|b', 'build');
    expect(link).toBe('build');
    expect(link).not.toContain('<');
  });

  test('slackLink returns plain escaped text when no url is given', () => {
    expect(slackLink(undefined, 'a & b')).toBe('a &amp; b');
  });

  test('slackLink escapes the label but never the url', () => {
    const link = slackLink('https://example.com/?a=1&b=2', 'A & B');
    expect(link).toBe('<https://example.com/?a=1&b=2|A &amp; B>');
  });
});
