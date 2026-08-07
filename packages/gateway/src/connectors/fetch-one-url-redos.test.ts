import { expect, test } from "bun:test";

import { GITLAB_MR_URL_RE } from "./gitlab-sync.ts";
import { JENKINS_BUILD_URL_RE } from "./jenkins-sync.ts";
import { JIRA_BROWSE_URL_RE } from "./jira-sync.ts";

// Every quantifier in these three `fetchOne` URL patterns is bounded ({1,N}), which should make
// them linear-time by construction — this proves it against adversarial input rather than
// assuming it. The URL is caller-supplied and reaches an API path in all three connectors.
test("the fetchOne url patterns are linear on adversarial input", () => {
  const evil = `https://x/${"a/".repeat(20_000)}`;
  for (const re of [GITLAB_MR_URL_RE, JENKINS_BUILD_URL_RE, JIRA_BROWSE_URL_RE]) {
    const t0 = performance.now();
    re.exec(evil);
    expect(performance.now() - t0).toBeLessThan(100);
  }
});
