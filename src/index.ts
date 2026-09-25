// Public API barrel. The reporter is NOT re-exported here - it lives at the
// './reporter' subpath (package.json's `exports` map) so importing this
// entrypoint never pulls in the `@playwright/test/reporter` type import
// (erased at compile time, but there is no reason to couple the two).

export type { TestOutcome, RunSummary, BuildContext } from './model.js';

export {
  buildMessage,
  buildMessageAsync,
  type MessageOptions,
  type DefaultBlocks,
  type BuiltMessage,
} from './message.js';

export {
  type Block,
  type SectionBlock,
  type HeaderBlock,
  type ContextBlock,
  type DividerBlock,
  type SlackMessage,
  type TextObject,
  type PlainTextObject,
  type MrkdwnTextObject,
  assertWithinLimits,
  SlackMessageError,
} from './blocks.js';

export {
  send,
  type SendOptions,
  type SendResult,
  type SendErrorCode,
  type Transport,
  type WebhookTransport,
  type BotTokenTransport,
} from './send.js';

export { notify, type NotifyOptions } from './notify.js';

export {
  fromFailedTests,
  fromAnalysis,
  type FailedTestLike,
  type FromFailedTestsOptions,
  type TestSummaryLike,
  type AnalyzeResultLike,
} from './adapt.js';

export { summaryFromReport, type RawPlaywrightReport } from './report.js';
