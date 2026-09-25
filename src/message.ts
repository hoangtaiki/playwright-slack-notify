// Turns a RunSummary into a Slack Block Kit message. This is the one place
// grouping, truncation and block budgeting happen - the reporter and the CLI
// both funnel through here (see the architecture note in model.ts).

import { basename } from 'node:path';
import type { RunSummary, TestOutcome } from './model.js';
import {
  type Block,
  type SectionBlock,
  type SlackMessage,
  HEADER_TEXT_MAX,
  SECTION_FIELDS_MAX,
  SECTION_TEXT_BUDGET,
  context,
  enforceLimits,
  fieldsSection,
  header,
  section,
} from './blocks.js';
import {
  escapeMrkdwn,
  fitEscaped,
  measureBytes,
  normalize,
  slackLink,
  truncate,
} from './text.js';

export interface DefaultBlocks {
  readonly header?: Block;
  readonly status: Block;
  readonly meta?: Block;
  readonly reportErrors?: Block;
  /** The failure/flaky list, already grouped, truncated and packed - plus a
   *  trailing "and N more" context block if anything was cut. */
  readonly failures: readonly Block[];
  readonly footer: readonly Block[];
  /** The full assembled default block list, in the order buildMessage would
   *  otherwise send it. A `layout` that only wants to inject one block can
   *  splice this instead of rebuilding grouping/truncation/budgeting itself. */
  readonly blocks: readonly Block[];
}

export interface MessageOptions {
  /** `false` drops the header block entirely. A function lets the caller
   *  template it (e.g. inject a branch name or ticket number) without
   *  touching Block Kit. Default: `<label or job> - <outcome label>`. */
  readonly header?: string | false | ((summary: RunSummary) => string);
  /** The notification fallback line. Always populated even if omitted -
   *  see resolveText(). */
  readonly text?: string | ((summary: RunSummary) => string);
  /** Extra blocks appended after the failure list. Dropped WHOLE (never
   *  truncated) if they do not fit - see enforceLimits' doc comment for why. */
  readonly footer?: readonly Block[];
  readonly emoji?: Partial<Record<RunSummary['outcome'], string>>;
  readonly groupBy?: 'file' | 'project' | 'none';
  readonly showErrors?: boolean;
  /** Whether a flaky-only run (no hard failures) still posts. Default true -
   *  see "When to stay silent" in the design; this package is named for all
   *  outcomes and would contradict that if it stayed silent by default. */
  readonly notifyOnFlaky?: boolean;
  /** Per-test link to source, e.g. a GitHub blob URL. Deliberately a
   *  callback rather than a URL template: a template would need a
   *  host-specific line-anchor format baked in, which is exactly the kind
   *  of workflow-specific policy this library keeps out of its API. */
  readonly sourceUrl?: (test: TestOutcome) => string | undefined;
  /** Readability cap on how many failing/flaky tests are listed. Default 5 -
   *  a Slack message is a notification, not a report. `0` posts counts only. */
  readonly maxTests?: number;
  /** Cosmetic per-title truncation. `false` disables it - the hard Slack
   *  ceilings still apply regardless (see enforceLimits). */
  readonly maxTitleChars?: number | false;
  readonly maxErrorChars?: number | false;
  /** Which part of a nested title to render per line. `FailedTest.title` is
   *  the WHOLE path joined by ' > ', so a nested scenario can run well past
   *  200 characters before any error text is added. Default 'own'. */
  readonly titleStyle?: 'own' | 'full' | 'path';
  readonly layout?: (
    summary: RunSummary,
    defaults: DefaultBlocks
  ) => readonly Block[];
  readonly layoutAsync?: (
    summary: RunSummary,
    defaults: DefaultBlocks
  ) => Promise<readonly Block[]>;
}

export interface BuiltMessage extends SlackMessage {
  /** Anything enforceLimits had to trim to keep the message valid. Never
   *  sent to Slack - send() picks only `text`/`blocks` off this object. */
  readonly warnings: readonly string[];
}

const DEFAULT_MAX_TESTS = 5;
const DEFAULT_MAX_TITLE_CHARS = 160;
const DEFAULT_MAX_ERROR_CHARS = 200;
const FALLBACK_TEXT = 'Playwright test results';
/** Our own bound on the notification `text` line - a cosmetic choice, not a
 *  Slack limit, kept well under Slack's 3000-char section ceiling. */
const TEXT_FIELD_BUDGET = 300;

const OUTCOME_EMOJI: Record<RunSummary['outcome'], string> = {
  passed: ':white_check_mark:',
  failed: ':red_circle:',
  timedout: ':hourglass_flowing_sand:',
  interrupted: ':warning:',
};

const OUTCOME_LABEL: Record<RunSummary['outcome'], string> = {
  passed: 'Build Success',
  failed: 'Build Failure',
  timedout: 'Build Timed Out',
  interrupted: 'Build Interrupted',
};

interface ResolvedRenderOptions {
  readonly groupBy: 'file' | 'project' | 'none';
  readonly titleStyle: 'own' | 'full' | 'path';
  readonly maxTitleBytes: number;
  readonly maxErrorBytes: number;
  readonly showErrors: boolean;
  readonly sourceUrl?: (test: TestOutcome) => string | undefined;
}

/** Frame entries are tagged by key so degradation can drop by NAME rather
 *  than by value identity, and so footer entries can be dropped from the
 *  end while meta/reportErrors/header have a single, fixed priority. */
interface FrameEntry {
  readonly key: string;
  readonly block: Block;
}

function computeDefaults(
  summary: RunSummary,
  options: MessageOptions
): { defaults: DefaultBlocks; fallbackText: string; warnings: string[] } {
  const warnings: string[] = [];
  const groupBy = options.groupBy ?? 'file';
  const titleStyle = options.titleStyle ?? 'own';
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const maxTitleBytes =
    options.maxTitleChars === false
      ? Infinity
      : (options.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS);
  const maxErrorBytes =
    options.maxErrorChars === false
      ? Infinity
      : (options.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS);
  const showErrors = options.showErrors ?? true;
  const notifyOnFlaky = options.notifyOnFlaky ?? true;

  const renderOpts: ResolvedRenderOptions = {
    groupBy,
    titleStyle,
    maxTitleBytes,
    maxErrorBytes,
    showErrors,
    sourceUrl: options.sourceUrl,
  };

  const emoji =
    options.emoji?.[summary.outcome] ?? OUTCOME_EMOJI[summary.outcome];
  const outcomeLabel = OUTCOME_LABEL[summary.outcome];

  // --- Header (optional) ---
  let headerBlock: Block | undefined;
  if (options.header !== false) {
    const raw =
      typeof options.header === 'function'
        ? options.header(summary)
        : (options.header ??
          `${summary.build?.label ?? summary.build?.job ?? 'Playwright'} - ${outcomeLabel}`);
    // header.text MUST be plain_text, which does not parse mrkdwn, so a link
    // there would render literally - strip <> rather than entity-escape,
    // since whether plain_text decodes entities is unverified (see the plan).
    const cleaned = `${emoji}  ${raw}`
      .replace(/[<>]/g, '')
      .replace(/[\r\n]+/g, ' ');
    headerBlock = header(truncate(cleaned, HEADER_TEXT_MAX - 10));
  }

  // --- Status section (mandatory, never dropped) ---
  const statusBlock = buildStatusSection(summary);

  // --- Meta ---
  const metaBlock =
    summary.meta && summary.meta.length > 0
      ? buildMetaSection(summary.meta)
      : undefined;

  // --- Report errors ---
  const reportErrorsBlock =
    summary.reportErrors && summary.reportErrors.length > 0
      ? buildReportErrorsSection(summary.reportErrors)
      : undefined;

  // --- Frame + degradation ---
  const footerBlocks = options.footer ?? [];
  let entries: FrameEntry[] = [
    ...(headerBlock ? [{ key: 'header', block: headerBlock }] : []),
    { key: 'status', block: statusBlock },
    ...(metaBlock ? [{ key: 'meta', block: metaBlock }] : []),
    ...(reportErrorsBlock
      ? [{ key: 'reportErrors', block: reportErrorsBlock }]
      : []),
    ...footerBlocks.map((block, i) => ({ key: `footer:${i}`, block })),
  ];
  entries = degradeFrame(entries, warnings);
  const survivingKeys = new Set(entries.map(e => e.key));

  const finalHeader = survivingKeys.has('header') ? headerBlock : undefined;
  const finalMeta = survivingKeys.has('meta') ? metaBlock : undefined;
  const finalReportErrors = survivingKeys.has('reportErrors')
    ? reportErrorsBlock
    : undefined;
  const finalFooter = footerBlocks.filter((_, i) =>
    survivingKeys.has(`footer:${i}`)
  );

  // 50 total minus whatever the (degraded) frame occupies - this is the
  // computed, not hardcoded, budget the failure packer gets to work with.
  const freeSlots = 50 - entries.length;

  const { blocks: failureBlocks } = buildFailureBlocks(
    summary,
    renderOpts,
    Math.max(freeSlots, 0),
    maxTests,
    notifyOnFlaky
  );

  const blocks: Block[] = [
    ...(finalHeader ? [finalHeader] : []),
    statusBlock,
    ...(finalMeta ? [finalMeta] : []),
    ...(finalReportErrors ? [finalReportErrors] : []),
    ...failureBlocks,
    ...finalFooter,
  ];

  const defaults: DefaultBlocks = {
    header: finalHeader,
    status: statusBlock,
    meta: finalMeta,
    reportErrors: finalReportErrors,
    failures: failureBlocks,
    footer: finalFooter,
    blocks,
  };

  const fallbackText = buildFallbackText(summary, outcomeLabel);
  return { defaults, fallbackText, warnings };
}

/**
 * Degrade the frame (everything that is not a failure/flaky section) until
 * it leaves at least 2 free slots out of Slack's 50-block ceiling, i.e.
 * `entries.length <= 48`. Keying the threshold off 49 instead would leave a
 * single free slot that the packer's own "reserve one for the overflow
 * marker" rule then consumes entirely, producing a message with zero test
 * content.
 *
 * Priority order, lowest priority (dropped first) to highest: meta, report
 * errors, footer (from the END), header. `status` is never a candidate.
 */
function degradeFrame(entries: FrameEntry[], warnings: string[]): FrameEntry[] {
  let list = entries;

  const dropOne = (predicate: (e: FrameEntry) => boolean): boolean => {
    if (list.length <= 48) return false;
    // Scan from the end so footer entries drop from the tail, per the
    // priority order above; for a single-instance key (meta, reportErrors,
    // header) direction does not matter.
    for (let i = list.length - 1; i >= 0; i--) {
      if (predicate(list[i])) {
        warnings.push(
          `dropped frame block '${list[i].key}' to stay within Slack's block limit`
        );
        list = list.filter((_, idx) => idx !== i);
        return true;
      }
    }
    return false;
  };

  dropOne(e => e.key === 'meta');
  dropOne(e => e.key === 'reportErrors');
  while (list.length > 48 && dropOne(e => e.key.startsWith('footer:'))) {
    /* keep dropping footer entries from the end */
  }
  dropOne(e => e.key === 'header');

  return list;
}

function buildStatusSection(summary: RunSummary): SectionBlock {
  const b = summary.build;
  const parts: string[] = [];
  if (b?.job) parts.push(escapeMrkdwn(b.job));
  if (b?.buildNumber !== undefined)
    parts.push(`#${escapeMrkdwn(String(b.buildNumber))}`);
  if (b?.author) parts.push(escapeMrkdwn(b.author));
  const duration = formatDuration(summary.duration);
  if (duration) parts.push(duration);
  if (b?.buildUrl) parts.push(slackLink(b.buildUrl, 'build'));
  if (b?.reportUrl) parts.push(slackLink(b.reportUrl, 'report'));
  if (b?.commit?.sha) {
    parts.push(slackLink(b.commit.url, b.commit.sha.slice(0, 7)));
  }
  const line1 = parts.join(' · ');

  const counts: string[] = [];
  if (summary.failed > 0) counts.push(`${summary.failed} failed`);
  if (summary.flaky > 0) counts.push(`${summary.flaky} flaky`);
  if (summary.passed > 0) counts.push(`${summary.passed} passed`);
  if (summary.skipped > 0) counts.push(`${summary.skipped} skipped`);
  const line2 = counts.length > 0 ? counts.join(' · ') : '0 tests ran';

  const text = [line1, line2].filter(l => l.length > 0).join('\n');
  return section(text);
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function buildMetaSection(
  meta: readonly { key: string; value: string }[]
): SectionBlock {
  const fields = meta
    .slice(0, SECTION_FIELDS_MAX)
    .map(
      m =>
        `*${escapeMrkdwn(truncate(m.key, 60))}*\n${escapeMrkdwn(truncate(m.value, 200))}`
    );
  return fieldsSection(fields);
}

function buildReportErrorsSection(
  errors: readonly { message?: string }[]
): SectionBlock {
  const shown = errors.slice(0, 10);
  const lines = [
    ':warning: *Report errors:*',
    ...shown.map(
      e => `• ${fitEscaped(normalize(e.message ?? '(no message)'), 300)}`
    ),
  ];
  if (errors.length > shown.length) {
    lines.push(`_… and ${errors.length - shown.length} more_`);
  }
  return section(lines.join('\n'));
}

function renderTitle(
  test: TestOutcome,
  style: 'own' | 'full' | 'path'
): string {
  const path = test.titlePath;
  if (style === 'full') return test.title;
  if (!path || path.length === 0) return lastSegment(test.title);
  if (style === 'own') return path[path.length - 1];
  // 'path': drop the leading file segment, keep the rest of the describe path.
  return path.length > 1 ? path.slice(1).join(' > ') : path[0];
}

function lastSegment(title: string): string {
  const idx = title.lastIndexOf(' > ');
  return idx === -1 ? title : title.slice(idx + 3);
}

function renderTestLine(
  test: TestOutcome,
  opts: ResolvedRenderOptions
): string {
  const isFlaky = test.status === 'flaky';
  const icon = isFlaky ? ':warning:' : ':x:';
  const titleRaw = normalize(renderTitle(test, opts.titleStyle));
  const titleFit = fitEscaped(titleRaw, opts.maxTitleBytes);
  let line = `${icon} *${titleFit}*`;

  if (test.project) {
    line += `  \`${fitEscaped(test.project, 60)}\``;
  }
  const attempts = (test.retries ?? 0) + 1;
  if (attempts > 1) line += `  ×${attempts}`;

  const src = opts.sourceUrl?.(test);
  if (src) {
    const label = test.file
      ? `${basename(test.file)}${test.line ? `:${test.line}` : ''}`
      : 'source';
    line += `  ${slackLink(src, label)}`;
  }

  if (opts.showErrors && test.error) {
    const errFit = fitEscaped(normalize(test.error), opts.maxErrorBytes);
    if (errFit.length > 0) line += `\n     ${errFit}`;
  }
  return line;
}

function groupKeyFor(
  test: TestOutcome,
  groupBy: 'file' | 'project' | 'none'
): string {
  if (groupBy === 'project') return test.project ?? '(default project)';
  return test.file ?? test.titlePath?.[0] ?? '(unknown file)';
}

interface LineEntry {
  readonly text: string;
  readonly isTest: boolean;
}

function buildFlatLines(
  items: readonly TestOutcome[],
  opts: ResolvedRenderOptions
): LineEntry[] {
  const out: LineEntry[] = [];
  let lastGroupKey: string | undefined;
  for (const item of items) {
    if (opts.groupBy !== 'none') {
      const key = groupKeyFor(item, opts.groupBy);
      if (key !== lastGroupKey) {
        out.push({
          text: `*${escapeMrkdwn(truncate(key, 200))}*`,
          isTest: false,
        });
        lastGroupKey = key;
      }
    }
    out.push({ text: renderTestLine(item, opts), isTest: true });
  }
  return out;
}

/**
 * Greedily pack lines into sections of at most SECTION_TEXT_BUDGET bytes
 * each, up to `blockCapacity` sections. A line is only counted as "consumed"
 * once its section actually flushes INTO the result - if capacity runs out
 * mid-section, that section (and its lines) is discarded rather than
 * double-counted, so the caller's remainder math stays correct.
 *
 * Known minor cosmetic edge case, accepted rather than engineered around: a
 * group heading can end up alone in a section whose first test line rolls
 * into a section that then gets discarded for lack of capacity. This needs a
 * specific byte alignment to happen and, with the default maxTests of 5, is
 * exceedingly unlikely to occur in practice.
 */
function packLines(
  lines: readonly LineEntry[],
  blockCapacity: number
): { sections: SectionBlock[]; consumedTests: number } {
  const sections: SectionBlock[] = [];
  let current: LineEntry[] = [];
  let bytes = 0;
  let consumedTests = 0;

  const flush = () => {
    if (current.length === 0) return;
    if (sections.length < blockCapacity) {
      sections.push(section(current.map(e => e.text).join('\n')));
      consumedTests += current.filter(e => e.isTest).length;
    }
    current = [];
    bytes = 0;
  };

  for (const entry of lines) {
    if (sections.length >= blockCapacity && current.length === 0) break;
    const cost = measureBytes(entry.text) + (current.length > 0 ? 1 : 0);
    if (bytes + cost > SECTION_TEXT_BUDGET && current.length > 0) {
      flush();
      if (sections.length >= blockCapacity) break;
    }
    current.push(entry);
    bytes += cost;
  }
  flush();

  return { sections, consumedTests };
}

function buildFailureBlocks(
  summary: RunSummary,
  opts: ResolvedRenderOptions,
  freeSlots: number,
  maxTests: number,
  notifyOnFlaky: boolean
): { blocks: Block[] } {
  const allItems: TestOutcome[] = [...summary.failures];
  if (notifyOnFlaky && summary.flakyTests) allItems.push(...summary.flakyTests);

  if (maxTests <= 0 || allItems.length === 0 || freeSlots <= 0) {
    return { blocks: [] };
  }

  const shown = allItems.slice(0, maxTests);
  const readabilityRemainder = allItems.length - shown.length;
  const lines = buildFlatLines(shown, opts);

  // First pass: everything might fit with room to spare, needing no
  // overflow marker at all.
  let { sections, consumedTests } = packLines(lines, freeSlots);
  let capacityRemainder = shown.length - consumedTests;

  if (capacityRemainder > 0 || readabilityRemainder > 0) {
    // Reserve one slot for the "and N more" marker and repack - see the
    // design's non-oscillation proof: needed > freeSlots in this branch, so
    // the remainder computed below is always >= 1 and the marker is always
    // warranted.
    const capacity = Math.max(freeSlots - 1, 0);
    ({ sections, consumedTests } = packLines(lines, capacity));
    capacityRemainder = shown.length - consumedTests;
  }

  const totalRemainder = capacityRemainder + readabilityRemainder;
  const blocks: Block[] = [...sections];
  if (totalRemainder > 0 && sections.length < freeSlots) {
    blocks.push(context([`_… and ${totalRemainder} more_`]));
  }
  return { blocks };
}

function buildFallbackText(summary: RunSummary, outcomeLabel: string): string {
  const job = summary.build?.job ?? 'Playwright';
  const parts = [job, outcomeLabel];
  if (summary.failed > 0) parts.push(`${summary.failed} failed test(s)`);
  if (summary.flaky > 0) parts.push(`${summary.flaky} flaky`);
  return parts.join(' - ');
}

function resolveText(
  summary: RunSummary,
  options: MessageOptions,
  fallback: string
): string {
  const raw =
    typeof options.text === 'function'
      ? options.text(summary)
      : (options.text ?? fallback);
  // No link markup in the notification line - see the design's Links
  // section - so <> are stripped rather than escaped.
  const cleaned = normalize(raw).replace(/[<>]/g, '');
  const fitted = fitEscaped(cleaned, TEXT_FIELD_BUDGET);
  return fitted.length > 0 ? fitted : FALLBACK_TEXT;
}

function finalize(
  text: string,
  blocks: readonly Block[],
  priorWarnings: readonly string[]
): BuiltMessage {
  const { message, warnings } = enforceLimits({ text, blocks });
  return { ...message, warnings: [...priorWarnings, ...warnings] };
}

/**
 * Build a Slack message synchronously. Throws if `options.layoutAsync` is
 * given - that hook needs an await, so use `buildMessageAsync` or `notify`
 * instead.
 */
export function buildMessage(
  summary: RunSummary,
  options: MessageOptions = {}
): BuiltMessage {
  if (options.layoutAsync) {
    throw new Error(
      'playwright-slack-notify: options.layoutAsync requires buildMessageAsync() or notify() - buildMessage() is synchronous'
    );
  }
  const { defaults, fallbackText, warnings } = computeDefaults(
    summary,
    options
  );
  const blocks = options.layout
    ? options.layout(summary, defaults)
    : defaults.blocks;
  const text = resolveText(summary, options, fallbackText);
  return finalize(text, blocks, warnings);
}

/**
 * Build a Slack message, awaiting `options.layoutAsync` if given (falling
 * back to `options.layout`, then the default blocks). `notify()` always
 * calls this rather than `buildMessage()`, since it is a strict superset.
 */
export async function buildMessageAsync(
  summary: RunSummary,
  options: MessageOptions = {}
): Promise<BuiltMessage> {
  const { defaults, fallbackText, warnings } = computeDefaults(
    summary,
    options
  );
  const blocks = options.layoutAsync
    ? await options.layoutAsync(summary, defaults)
    : options.layout
      ? options.layout(summary, defaults)
      : defaults.blocks;
  const text = resolveText(summary, options, fallbackText);
  return finalize(text, blocks, warnings);
}
