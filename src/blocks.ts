// A minimal, local Block Kit type surface - only the block and text-object
// shapes this package actually emits (section, header, context, divider).
// Kept local rather than pulled from a Slack SDK: that would be exactly the
// runtime dependency this package's README promises it does not have.
//
// Limits below are Slack's documented Block Kit limits
// (docs.slack.dev/reference/block-kit/blocks and the per-block pages),
// re-verify if anything looks off - see the plan's "Verified facts" section.

import { measureBytes, truncate } from './text.js';

export interface PlainTextObject {
  readonly type: 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

export interface MrkdwnTextObject {
  readonly type: 'mrkdwn';
  readonly text: string;
  readonly verbatim?: boolean;
}

export type TextObject = PlainTextObject | MrkdwnTextObject;

export interface SectionBlock {
  readonly type: 'section';
  readonly block_id?: string;
  readonly text?: TextObject;
  readonly fields?: readonly TextObject[];
}

export interface HeaderBlock {
  readonly type: 'header';
  readonly block_id?: string;
  readonly text: PlainTextObject;
}

export interface ContextBlock {
  readonly type: 'context';
  readonly block_id?: string;
  readonly elements: readonly TextObject[];
}

export interface DividerBlock {
  readonly type: 'divider';
  readonly block_id?: string;
}

export type Block = SectionBlock | HeaderBlock | ContextBlock | DividerBlock;

export interface SlackMessage {
  /** The notification fallback line. Always non-empty - see buildMessage. */
  readonly text: string;
  readonly blocks: readonly Block[];
}

// --- Limits (Block Kit, verified against docs.slack.dev) ---

export const MAX_BLOCKS = 50;
export const SECTION_TEXT_MAX = 3000;
/** Working budget below the hard 3000-char limit, leaving headroom for
 *  measurement being an estimate (see truncate()'s byte-vs-codepoint note). */
export const SECTION_TEXT_BUDGET = 2900;
export const SECTION_FIELDS_MAX = 10;
export const SECTION_FIELD_TEXT_MAX = 2000;
export const HEADER_TEXT_MAX = 150;
export const CONTEXT_ELEMENTS_MAX = 10;
export const BLOCK_ID_MAX = 255;

// --- Builders ---

export function plainText(text: string, emoji = true): PlainTextObject {
  return { type: 'plain_text', text, emoji };
}

export function mrkdwn(text: string): MrkdwnTextObject {
  return { type: 'mrkdwn', text };
}

export function section(
  text: string,
  opts: { fields?: readonly string[]; blockId?: string } = {}
): SectionBlock {
  return {
    type: 'section',
    ...(opts.blockId ? { block_id: opts.blockId } : {}),
    text: mrkdwn(text),
    ...(opts.fields ? { fields: opts.fields.map(mrkdwn) } : {}),
  };
}

export function header(text: string): HeaderBlock {
  return { type: 'header', text: plainText(text) };
}

export function context(elements: readonly string[]): ContextBlock {
  return { type: 'context', elements: elements.map(mrkdwn) };
}

export function divider(): DividerBlock {
  return { type: 'divider' };
}

/** A section with no top-level `text`, only `fields` - Slack requires a
 *  section to have at least one of `text`/`fields`, and a fields-only
 *  section is how key/value metadata rows are rendered. */
export function fieldsSection(fields: readonly string[]): SectionBlock {
  return { type: 'section', fields: fields.map(mrkdwn) };
}

// --- Verification: the shared oracle ---

export class SlackMessageError extends Error {}

/**
 * Throws if `message` violates a hard Slack Block Kit limit. This is the
 * production safety net AND the thing tests assert against directly - never
 * a committed expected-payload snapshot. `enforceLimits` below is what
 * actually FIXES a message; this only verifies one.
 */
export function assertWithinLimits(message: SlackMessage): void {
  if (message.blocks.length > MAX_BLOCKS) {
    throw new SlackMessageError(
      `playwright-slack-notify: message has ${message.blocks.length} blocks, exceeding Slack's limit of ${MAX_BLOCKS}`
    );
  }
  if (!message.text || message.text.length === 0) {
    throw new SlackMessageError(
      'playwright-slack-notify: message.text must be non-empty (Slack rejects a blocks-only payload with no fallback text as no_text)'
    );
  }
  for (const [index, block] of message.blocks.entries()) {
    assertBlockWithinLimits(block, index);
  }
}

function assertBlockWithinLimits(block: Block, index: number): void {
  if (block.block_id && measureBytes(block.block_id) > BLOCK_ID_MAX) {
    throw new SlackMessageError(
      `playwright-slack-notify: block[${index}].block_id exceeds ${BLOCK_ID_MAX} bytes`
    );
  }
  switch (block.type) {
    case 'section': {
      if (block.text && measureBytes(block.text.text) > SECTION_TEXT_MAX) {
        throw new SlackMessageError(
          `playwright-slack-notify: block[${index}] section text exceeds ${SECTION_TEXT_MAX} bytes`
        );
      }
      if (block.fields) {
        if (block.fields.length > SECTION_FIELDS_MAX) {
          throw new SlackMessageError(
            `playwright-slack-notify: block[${index}] has ${block.fields.length} fields, exceeding ${SECTION_FIELDS_MAX}`
          );
        }
        for (const field of block.fields) {
          if (measureBytes(field.text) > SECTION_FIELD_TEXT_MAX) {
            throw new SlackMessageError(
              `playwright-slack-notify: block[${index}] field text exceeds ${SECTION_FIELD_TEXT_MAX} bytes`
            );
          }
        }
      }
      break;
    }
    case 'header': {
      if (measureBytes(block.text.text) > HEADER_TEXT_MAX) {
        throw new SlackMessageError(
          `playwright-slack-notify: block[${index}] header text exceeds ${HEADER_TEXT_MAX} bytes`
        );
      }
      break;
    }
    case 'context': {
      if (block.elements.length > CONTEXT_ELEMENTS_MAX) {
        throw new SlackMessageError(
          `playwright-slack-notify: block[${index}] has ${block.elements.length} context elements, exceeding ${CONTEXT_ELEMENTS_MAX}`
        );
      }
      break;
    }
    case 'divider':
      break;
  }
}

const FALLBACK_TEXT = 'Playwright test results';

/**
 * The one thing EVERY path through this package goes through before a
 * message is sent - the default builder in message.ts, and any caller
 * `layout`/`layoutAsync` override. A hostile or careless custom layout
 * (too many blocks, a single oversized section) cannot produce a message
 * Slack would reject: this trims it, and reports what it trimmed.
 *
 * Trimming strategy is deliberately coarse and safe rather than clever:
 * a whole trailing block is dropped rather than reformatted, because we do
 * not know what a caller-supplied block MEANS. See the design's note on why
 * footer blocks are dropped whole, never truncated in place - the same
 * argument that motivated dropping the (removed) grep-pattern truncation.
 */
export function enforceLimits(message: SlackMessage): {
  message: SlackMessage;
  warnings: string[];
} {
  const warnings: string[] = [];
  let blocks = message.blocks.map((block, index) =>
    fitBlock(block, index, warnings)
  );

  if (blocks.length > MAX_BLOCKS) {
    const kept = blocks.slice(0, MAX_BLOCKS - 1);
    const dropped = blocks.length - kept.length;
    warnings.push(
      `dropped ${dropped} block(s) to stay within Slack's ${MAX_BLOCKS}-block limit`
    );
    blocks = [
      ...kept,
      context([`_${dropped} more block(s) omitted_`]) as Block,
    ];
  }

  const text =
    message.text && message.text.length > 0 ? message.text : FALLBACK_TEXT;

  return { message: { text, blocks }, warnings };
}

function fitBlock(block: Block, index: number, warnings: string[]): Block {
  switch (block.type) {
    case 'section': {
      let next = block;
      if (next.text && measureBytes(next.text.text) > SECTION_TEXT_MAX) {
        warnings.push(`truncated oversized section text at block[${index}]`);
        next = {
          ...next,
          text: mrkdwn(truncate(next.text.text, SECTION_TEXT_BUDGET)),
        };
      }
      if (next.fields) {
        let fields = next.fields;
        if (fields.length > SECTION_FIELDS_MAX) {
          warnings.push(
            `dropped ${fields.length - SECTION_FIELDS_MAX} field(s) at block[${index}] to stay within Slack's ${SECTION_FIELDS_MAX}-field limit`
          );
          fields = fields.slice(0, SECTION_FIELDS_MAX);
        }
        fields = fields.map(field =>
          measureBytes(field.text) > SECTION_FIELD_TEXT_MAX
            ? mrkdwn(truncate(field.text, SECTION_FIELD_TEXT_MAX - 20))
            : field
        );
        next = { ...next, fields };
      }
      return next;
    }
    case 'header': {
      if (measureBytes(block.text.text) > HEADER_TEXT_MAX) {
        warnings.push(`truncated oversized header text at block[${index}]`);
        return {
          ...block,
          text: plainText(
            truncate(block.text.text, HEADER_TEXT_MAX - 10),
            block.text.emoji
          ),
        };
      }
      return block;
    }
    case 'context': {
      if (block.elements.length > CONTEXT_ELEMENTS_MAX) {
        warnings.push(
          `dropped ${block.elements.length - CONTEXT_ELEMENTS_MAX} context element(s) at block[${index}] to stay within Slack's ${CONTEXT_ELEMENTS_MAX}-element limit`
        );
        return {
          ...block,
          elements: block.elements.slice(0, CONTEXT_ELEMENTS_MAX),
        };
      }
      return block;
    }
    case 'divider':
      return block;
  }
}
