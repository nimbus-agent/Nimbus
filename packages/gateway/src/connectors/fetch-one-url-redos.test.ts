import { expect, test } from "bun:test";

import { GITLAB_MR_URL_RE } from "./gitlab-sync.ts";
import { JENKINS_BUILD_URL_RE } from "./jenkins-sync.ts";
import { JIRA_BROWSE_URL_RE } from "./jira-sync.ts";

// A SHARED adversarial input (e.g. a long run of "a/") cannot prove much: Jenkins requires a
// literal "/job/" and Jira a literal "/browse/" immediately after the host, so a string that
// never contains those literals fails at the very first token — before the pattern's own bounded
// quantifier is ever engaged — and would stay "fast" even if that quantifier were later widened
// to unbounded or nested into something catastrophic. Each pattern below gets its own input that
// walks through its real literals and dumps a long run of otherwise-valid characters at the
// quantifier that matters, so a regression there would actually show up here.

test("GITLAB_MR_URL_RE stays linear on an adversarial namespaced path", () => {
  // Exercises the `[\w./-]{1,200}` namespace-path capture: a long run of allowed characters with
  // no "/-/merge_requests/" anywhere for the group to terminate against.
  const evil = `https://x/${"a".repeat(200_000)}`;
  const t0 = performance.now();
  GITLAB_MR_URL_RE.exec(evil);
  expect(performance.now() - t0).toBeLessThan(100);
});

test("JENKINS_BUILD_URL_RE stays linear on an adversarial nested job path", () => {
  // Exercises BOTH the inner `[\w.%-]{1,100}` per-segment class and the outer `{1,10}` repeat:
  // real "/job/<100 a's>" segments repeated well past the outer bound, then a non-digit tail so
  // the final match still fails after the engine has walked the whole nested structure.
  const segment = `/job/${"a".repeat(100)}`;
  const evil = `https://x${segment.repeat(30)}/notdigits`;
  const t0 = performance.now();
  JENKINS_BUILD_URL_RE.exec(evil);
  expect(performance.now() - t0).toBeLessThan(100);
});

test("JIRA_BROWSE_URL_RE stays linear on an adversarial browse path", () => {
  // Exercises the `[A-Z0-9_]{0,50}` key-suffix capture: a real "/browse/" prefix followed by a
  // long run of allowed characters with no "-<digits>" anywhere for the group to terminate
  // against.
  const evil = `https://x/browse/A${"A".repeat(200_000)}`;
  const t0 = performance.now();
  JIRA_BROWSE_URL_RE.exec(evil);
  expect(performance.now() - t0).toBeLessThan(100);
});
