import { test, expect } from '@playwright/test';
import { detectBuildContext, mergeBuildContext } from '../src/ci.js';

// Fake env objects, not process.env - these are hand-constructed on
// purpose, exactly like text.spec.ts's escapeMrkdwn cases: this is a pure
// helper's own input contract (an env-shaped record), not a snapshot of
// another tool's output.

test.describe('detectBuildContext', () => {
  test('returns undefined outside any recognised CI provider', () => {
    expect(detectBuildContext({})).toBeUndefined();
  });

  test('reads a full GitHub Actions environment', () => {
    const build = detectBuildContext({
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_RUN_ID: '4200',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_ACTOR: 'hoang',
      GITHUB_SHA: 'deadbeef',
    });
    expect(build).toEqual({
      job: 'CI',
      author: 'hoang',
      buildNumber: '42',
      buildUrl: 'https://github.com/acme/widgets/actions/runs/4200',
      commit: {
        sha: 'deadbeef',
        url: 'https://github.com/acme/widgets/commit/deadbeef',
      },
    });
  });

  test('a GitHub Actions env missing REPOSITORY/RUN_ID still returns the fields it can', () => {
    const build = detectBuildContext({
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'CI',
    });
    expect(build?.job).toBe('CI');
    expect(build?.buildUrl).toBeUndefined();
    expect(build?.commit).toBeUndefined();
  });

  test('a GitHub Actions env with a SHA but no REPOSITORY gives just the sha, no commit url', () => {
    const build = detectBuildContext({
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'deadbeef',
    });
    expect(build?.commit).toEqual({ sha: 'deadbeef', url: undefined });
  });

  test('reads a Jenkins environment', () => {
    const build = detectBuildContext({
      JENKINS_URL: 'https://jenkins.example.com/',
      JOB_NAME: 'main-develop-26505',
      BUILD_NUMBER: '412',
      BUILD_URL: 'https://jenkins.example.com/job/main-develop-26505/412/',
      GIT_COMMIT: 'cafef00d',
    });
    expect(build).toEqual({
      job: 'main-develop-26505',
      buildNumber: '412',
      buildUrl: 'https://jenkins.example.com/job/main-develop-26505/412/',
      commit: { sha: 'cafef00d' },
    });
  });

  test('a Jenkins environment is recognised from BUILD_URL alone, without JENKINS_URL', () => {
    const build = detectBuildContext({
      BUILD_URL: 'https://jenkins.example.com/job/x/1/',
    });
    expect(build?.buildUrl).toBe('https://jenkins.example.com/job/x/1/');
  });

  test('Jenkins never guesses a commit web link from GIT_COMMIT alone', () => {
    const build = detectBuildContext({
      BUILD_URL: 'https://jenkins.example.com/job/x/1/',
      GIT_COMMIT: 'cafef00d',
    });
    expect(build?.commit).toEqual({ sha: 'cafef00d' });
  });
});

test.describe('mergeBuildContext', () => {
  test('both undefined stays undefined', () => {
    expect(mergeBuildContext(undefined, undefined)).toBeUndefined();
  });

  test('detected only, no explicit override', () => {
    const detected = { job: 'CI', buildUrl: 'https://x/1' };
    expect(mergeBuildContext(detected, undefined)).toEqual(detected);
  });

  test('explicit only, no detection', () => {
    const explicit = { job: 'manual' };
    expect(mergeBuildContext(undefined, explicit)).toEqual(explicit);
  });

  test('explicit fields win per-field, detected fields fill the rest', () => {
    const detected = {
      job: 'CI',
      buildUrl: 'https://ci.example.com/42',
      author: 'bot',
    };
    const explicit = { reportUrl: 'https://reports.example.com/42' };
    expect(mergeBuildContext(detected, explicit)).toEqual({
      job: 'CI',
      buildUrl: 'https://ci.example.com/42',
      author: 'bot',
      reportUrl: 'https://reports.example.com/42',
    });
  });

  test('an explicit buildUrl fully replaces the detected one', () => {
    const detected = { buildUrl: 'https://ci.example.com/auto' };
    const explicit = { buildUrl: 'https://ci.example.com/manual' };
    expect(mergeBuildContext(detected, explicit)?.buildUrl).toBe(
      'https://ci.example.com/manual'
    );
  });
});
