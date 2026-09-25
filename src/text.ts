// Text handling for Slack mrkdwn. The pipeline used everywhere in this
// package is NORMALIZE -> TRUNCATE -> ESCAPE -> DECORATE, always in that
// order - see message.ts and the design notes on why. This module owns the
// first three steps; decoration (adding our own `*`/backtick/link markup)
// happens in message.ts, after these have already run.

const ENCODER = new TextEncoder();

/** UTF-8 byte length. Slack's docs do not state whether its char limits count
 *  bytes, UTF-16 units or code points; bytes is >= all three for any input,
 *  so measuring in bytes can only truncate EARLIER than strictly required,
 *  never later - conservative under every reading. */
export function measureBytes(value: string): number {
  return ENCODER.encode(value).length;
}

// Matches a full ANSI CSI escape sequence (colour codes, cursor movement,
// etc). Playwright error messages routinely carry these; left in place they
// render in Slack as literal `[2m[22m` garbage. Matching control characters
// is the entire point, hence the disable below.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// Other C0 control characters, excluding \r\n\t which are handled below.
// eslint-disable-next-line no-control-regex
const OTHER_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Strip ANSI escapes and control characters, collapse all whitespace
 *  (including newlines/tabs) to single spaces, and trim. Always the first
 *  step in the pipeline - everything downstream assumes plain text. */
export function normalize(value: string): string {
  return value
    .replace(ANSI_CSI, '')
    .replace(OTHER_CONTROL_CHARS, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const ELLIPSIS = '…';

/**
 * Cut `value` to at most `maxBytes` UTF-8 bytes, on a grapheme boundary (an
 * `Intl.Segmenter` cluster - a Node 20 global, no ICU flag needed), so a
 * surrogate pair or a ZWJ emoji sequence never splits. Prefers the last
 * whitespace boundary within the final 20% of the cut, to avoid chopping
 * mid-word. Appends an ellipsis, which itself counts against the budget.
 *
 * Must run BEFORE escaping and decoration (see the module doc): cutting
 * before either exist is what makes a balanced `*`/backtick pair and a
 * complete `&amp;` entity structurally guaranteed, not just likely.
 */
export function truncate(value: string, maxBytes: number): string {
  if (measureBytes(value) <= maxBytes) return value;

  const budget = maxBytes - measureBytes(ELLIPSIS);
  if (budget <= 0) return '';

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = Array.from(segmenter.segment(value), s => s.segment);

  let bytes = 0;
  let cutIndex = graphemes.length;
  for (let i = 0; i < graphemes.length; i++) {
    const next = bytes + measureBytes(graphemes[i]);
    if (next > budget) {
      cutIndex = i;
      break;
    }
    bytes = next;
  }

  let result = graphemes.slice(0, cutIndex).join('');
  const lastSpace = result.lastIndexOf(' ');
  if (lastSpace > result.length * 0.8) {
    result = result.slice(0, lastSpace);
  }

  return result + ELLIPSIS;
}

/**
 * The three characters Slack mrkdwn requires escaped, in the only safe
 * order: `&` FIRST, or the entities produced for `<`/`>` would themselves get
 * re-escaped. `*`, `_`, `~` and backtick have no Slack escape mechanism and
 * are deliberately left alone - see the design notes on why leaving them
 * unescaped is the least-bad option.
 *
 * Must run AFTER truncate() (never before): escaping expands length
 * (`&` -> `&amp;` is 1 byte to 5), so if it ran first, a cut could land
 * inside a multi-character entity and emit a broken `&am`. It must also run
 * on a single FRAGMENT, never an already-assembled line, or the `<url|label>`
 * syntax this package emits for links would itself get mangled.
 */
export function escapeMrkdwn(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fit a raw (un-escaped, un-decorated) fragment into `maxBytes` of ESCAPED
 * output. Escaping is length-expanding, so `truncate(raw, maxBytes)` alone
 * does not guarantee the escaped result fits - a raw string of pure `&`
 * truncated to `maxBytes` becomes 5x that many bytes once escaped. This
 * shrinks the RAW budget and re-runs normalize's downstream steps until the
 * escaped result fits, so the section-budget guarantee holds regardless of
 * how much a particular string happens to inflate.
 *
 * Terminates because `rawBudget` strictly decreases every iteration (either
 * the proportional shrink is smaller, or the `-1` floor forces it), bounded
 * by a hard iteration cap as a backstop.
 */
export function fitEscaped(raw: string, maxBytes: number): string {
  let rawBudget = maxBytes;
  for (let i = 0; i < 8 && rawBudget > 0; i++) {
    const candidate = truncate(raw, rawBudget);
    const escaped = escapeMrkdwn(candidate);
    const size = measureBytes(escaped);
    if (size <= maxBytes) return escaped;
    const shrinkTo = Math.floor(rawBudget * (maxBytes / size));
    rawBudget = Math.min(rawBudget - 1, Math.max(shrinkTo, 0));
  }
  return '';
}

/** Characters that would break Slack's `<url|label>` link syntax if present
 *  in the URL itself: `|` or `>` would terminate it early and let the rest
 *  of the string inject arbitrary markup. */
const UNSAFE_URL_CHARS = /[<>|\s]/;

/** Whether `url` is safe to place inside `<url|label>`. Validated, never
 *  escaped - there is no Slack escape for these characters inside a URL, so
 *  a failing URL must degrade to plain text instead. */
export function isValidSlackUrl(url: string): boolean {
  if (UNSAFE_URL_CHARS.test(url)) return false;
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Render a Slack link, or plain escaped text if the URL is missing or
 * invalid. Slack's link syntax is `<url|label>`, NOT markdown `[label](url)`
 * - writing the markdown form is the single most common Block Kit mistake
 * and renders as literal text.
 */
export function slackLink(url: string | undefined, label: string): string {
  const escapedLabel = escapeMrkdwn(label);
  if (!url || !isValidSlackUrl(url)) return escapedLabel;
  return `<${url}|${escapedLabel}>`;
}
