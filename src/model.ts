// The neutral model this package builds a Slack message from. Both adapters
// (the reporter reading a live Suite/TestCase tree, and the CLI/library
// reading a JSON report or a playwright-report-analyzer FailedTest[]) funnel
// into a RunSummary, and buildMessage() never sees anything else. This keeps
// the two input paths from growing separate formatting logic.

/**
 * One failing (or flaky) test, in the shape this package actually needs.
 *
 * Every field but `title` is optional, and every field's TYPE is deliberately
 * WIDER than the producer's - `status` is `string`, not a status union.
 * Structural assignability is one-directional: a producer's narrow union
 * assigns to our wider type, but not the reverse. This is what lets
 * `playwright-report-analyzer`'s `FailedTest[]` (or a hand-rolled object from
 * a live Suite walk) be consumed with NO runtime import, and it survives the
 * extractor adding a new status value without a breaking change here.
 */
export interface TestOutcome {
  /** Full title path joined by ' > ' (file > describe > ... > test). */
  readonly title: string;
  /** The same path unjoined; the test's own title is the last element. */
  readonly titlePath?: readonly string[];
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly project?: string;
  readonly tags?: readonly string[];
  /** First line of the error message. */
  readonly error?: string;
  readonly duration?: number;
  /** Attempts beyond the first that were needed before landing on this
   *  outcome (0 means it failed - or passed - on the only attempt seen). */
  readonly retries?: number;
  /** Deliberately a plain string, not a status union - see the interface
   *  doc above. Playwright's own two status vocabularies alone
   *  (`FullResult.status` uses lowercase `'timedout'`, `TestResult.status`
   *  uses camelCase `'timedOut'`) are reason enough not to pick a fixed set. */
  readonly status?: string;
}

/** Where a build came from and how to link back to it. The reporter and
 *  CLI surfaces fill this in automatically under GitHub Actions or Jenkins
 *  (see ci.ts's detectBuildContext) - a caller only needs to set fields
 *  here that can't be detected, like `reportUrl`, or to override one. */
export interface BuildContext {
  /** e.g. 'main-develop-26505'. */
  readonly job?: string;
  /** e.g. 'CHROME P1'. */
  readonly label?: string;
  /** Who triggered the build, if known. */
  readonly author?: string;
  readonly buildNumber?: string | number;
  /** Link to the CI build page. */
  readonly buildUrl?: string;
  /** Link to the published Playwright HTML report (distinct from buildUrl -
   *  see the Links section of the design). */
  readonly reportUrl?: string;
  readonly commit?: {
    readonly sha?: string;
    readonly url?: string;
  };
}

/**
 * The whole neutral model `buildMessage` consumes. Matches Playwright's own
 * `FullResult.status` vocabulary for `outcome` (lowercase `'timedout'`) since,
 * unlike `TestOutcome.status`, this field is always CONSTRUCTED by this
 * package's own adapters, never taken structurally from an unknown producer.
 */
export interface RunSummary {
  readonly outcome: 'passed' | 'failed' | 'timedout' | 'interrupted';
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly duration?: number;
  readonly startedAt?: string;
  readonly failures: readonly TestOutcome[];
  readonly flakyTests?: readonly TestOutcome[];
  /** Top-level report errors (e.g. a spec file that failed to import). A
   *  build can fail with these and zero failed tests - see "When to stay
   *  silent" in the design; silently skipping this case is exactly the
   *  silent-empty-output failure playwright-report-analyzer exists to
   *  prevent. */
  readonly reportErrors?: readonly { readonly message?: string }[];
  /** Arbitrary key/value rows the caller wants surfaced (branch, ticket,
   *  environment, ...). This is how organization- or team-specific context
   *  reaches the message without the library knowing about it. */
  readonly meta?: readonly { readonly key: string; readonly value: string }[];
  readonly build?: BuildContext;
}
