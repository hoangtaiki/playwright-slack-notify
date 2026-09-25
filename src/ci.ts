// Auto-detects CI build metadata from environment variables, so a build
// link shows up with zero config for anyone running under a recognised CI
// provider - this is something every adopter wants, not an NF- or
// project-specific policy: it reads only generic, publicly-documented env
// vars that GitHub Actions and Jenkins themselves set, never anything
// specific to one org's pipeline. An explicit `build` option always wins,
// per-field - see mergeBuildContext.
//
// Only these two providers are covered - the ones with a stable, public env
// var contract this package can rely on. Anyone on another CI provider is
// unaffected: they simply keep passing `build` explicitly, exactly as
// before this existed.

import type { BuildContext } from './model.js';

function fromGithubActions(env: NodeJS.ProcessEnv): BuildContext {
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const sha = env.GITHUB_SHA;
  return {
    job: env.GITHUB_WORKFLOW,
    author: env.GITHUB_ACTOR,
    buildNumber: env.GITHUB_RUN_NUMBER,
    buildUrl:
      repo && runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : undefined,
    commit: sha
      ? { sha, url: repo ? `${serverUrl}/${repo}/commit/${sha}` : undefined }
      : undefined,
  };
}

function fromJenkins(env: NodeJS.ProcessEnv): BuildContext {
  return {
    job: env.JOB_NAME,
    buildNumber: env.BUILD_NUMBER,
    buildUrl: env.BUILD_URL,
    // GIT_URL's format (SSH vs HTTPS, self-hosted vs github.com/gitlab.com)
    // varies too much to turn into a reliable commit web link - just the
    // sha, which is always safe to show.
    commit: env.GIT_COMMIT ? { sha: env.GIT_COMMIT } : undefined,
  };
}

/**
 * Detects CI build metadata from the process environment. Returns
 * `undefined` outside a recognised CI provider (e.g. a local run), so
 * callers can tell "nothing detected" apart from "detected, but empty".
 */
export function detectBuildContext(
  env: NodeJS.ProcessEnv = process.env
): BuildContext | undefined {
  if (env.GITHUB_ACTIONS === 'true') return fromGithubActions(env);
  if (env.JENKINS_URL ?? env.BUILD_URL) return fromJenkins(env);
  return undefined;
}

/**
 * Merges auto-detected build context with an explicit `build` option.
 * Explicit fields always win, but per FIELD rather than per object - passing
 * only `{ reportUrl: '...' }` still keeps an auto-detected buildUrl/commit
 * rather than discarding it.
 */
export function mergeBuildContext(
  detected: BuildContext | undefined,
  explicit: BuildContext | undefined
): BuildContext | undefined {
  if (!detected && !explicit) return undefined;
  return { ...detected, ...explicit };
}
