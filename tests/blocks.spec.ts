import { test, expect } from '@playwright/test';
import {
  BLOCK_ID_MAX,
  CONTEXT_ELEMENTS_MAX,
  HEADER_TEXT_MAX,
  MAX_BLOCKS,
  SECTION_FIELDS_MAX,
  SECTION_FIELD_TEXT_MAX,
  SECTION_TEXT_MAX,
  SlackMessageError,
  assertWithinLimits,
  context,
  enforceLimits,
  fieldsSection,
  header,
  section,
  type Block,
} from '../src/blocks.js';

// These are the library's OWN Block Kit types, not Playwright output - hand
// constructing them here is testing our own function against adversarial
// input, the same exception the sibling package's tests take for its own
// input types (FailedTest objects in grep.spec.ts).

test.describe('assertWithinLimits', () => {
  test('accepts a small, valid message', () => {
    expect(() =>
      assertWithinLimits({
        text: 'hello',
        blocks: [header('Title'), section('body')],
      })
    ).not.toThrow();
  });

  test('rejects more than MAX_BLOCKS blocks', () => {
    const blocks: Block[] = Array.from({ length: MAX_BLOCKS + 1 }, () =>
      section('x')
    );
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });

  test('rejects empty text (would be Slacks no_text error)', () => {
    expect(() =>
      assertWithinLimits({ text: '', blocks: [section('x')] })
    ).toThrow(SlackMessageError);
  });

  test('rejects a section text over SECTION_TEXT_MAX', () => {
    const blocks: Block[] = [section('x'.repeat(SECTION_TEXT_MAX + 1))];
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });

  test('rejects more than SECTION_FIELDS_MAX fields', () => {
    const fields = Array.from(
      { length: SECTION_FIELDS_MAX + 1 },
      (_, i) => `f${i}`
    );
    const blocks: Block[] = [fieldsSection(fields)];
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });

  test('rejects a field text over SECTION_FIELD_TEXT_MAX', () => {
    const blocks: Block[] = [
      fieldsSection(['x'.repeat(SECTION_FIELD_TEXT_MAX + 1)]),
    ];
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });

  test('rejects a header text over HEADER_TEXT_MAX', () => {
    const blocks: Block[] = [header('x'.repeat(HEADER_TEXT_MAX + 1))];
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });

  test('rejects more than CONTEXT_ELEMENTS_MAX context elements', () => {
    const elements = Array.from(
      { length: CONTEXT_ELEMENTS_MAX + 1 },
      (_, i) => `e${i}`
    );
    const blocks: Block[] = [context(elements)];
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });

  test('rejects a block_id over BLOCK_ID_MAX', () => {
    const blocks: Block[] = [
      { type: 'divider', block_id: 'x'.repeat(BLOCK_ID_MAX + 1) },
    ];
    expect(() => assertWithinLimits({ text: 'hi', blocks })).toThrow(
      SlackMessageError
    );
  });
});

test.describe('enforceLimits', () => {
  test('a valid message passes through unchanged, with no warnings', () => {
    const input = { text: 'hi', blocks: [header('Title'), section('body')] };
    const { message, warnings } = enforceLimits(input);
    expect(message).toEqual(input);
    expect(warnings).toEqual([]);
  });

  test('a hostile layout with 200 blocks is trimmed to MAX_BLOCKS with a warning, and comes back valid', () => {
    const blocks: Block[] = Array.from({ length: 200 }, (_, i) =>
      section(`line ${i}`)
    );
    const { message, warnings } = enforceLimits({ text: 'hi', blocks });
    expect(() => assertWithinLimits(message)).not.toThrow();
    expect(message.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a single 50,000-character section is truncated to fit, with a warning, and comes back valid', () => {
    const blocks: Block[] = [section('x'.repeat(50_000))];
    const { message, warnings } = enforceLimits({ text: 'hi', blocks });
    expect(() => assertWithinLimits(message)).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('empty text is replaced with a fallback, never left empty', () => {
    const { message } = enforceLimits({ text: '', blocks: [section('x')] });
    expect(message.text.length).toBeGreaterThan(0);
  });

  test('too many fields on one section are trimmed to SECTION_FIELDS_MAX', () => {
    const fields = Array.from({ length: 15 }, (_, i) => `f${i}`);
    const { message, warnings } = enforceLimits({
      text: 'hi',
      blocks: [fieldsSection(fields)],
    });
    expect(() => assertWithinLimits(message)).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('too many context elements are trimmed to CONTEXT_ELEMENTS_MAX', () => {
    const elements = Array.from({ length: 15 }, (_, i) => `e${i}`);
    const { message, warnings } = enforceLimits({
      text: 'hi',
      blocks: [context(elements)],
    });
    expect(() => assertWithinLimits(message)).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
