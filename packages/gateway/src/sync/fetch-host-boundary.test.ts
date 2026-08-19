import { describe, expect, test } from "bun:test";
import { deriveFetchHostMap, SAAS_HOSTS, serviceForHost } from "./fetch-host-boundary.ts";

/** `readConnectorSecret` calls `vault.get("<service>.<key>")` — so the fake keys on the FULL key. */
function fakeVault(secrets: Record<string, string>) {
  return {
    async get(fullKey: string): Promise<string | null> {
      return secrets[fullKey] ?? null;
    },
  } as unknown as Parameters<typeof deriveFetchHostMap>[0];
}

describe("fetch-host-boundary", () => {
  test("an unconfigured service is absent from the map entirely", async () => {
    const map = await deriveFetchHostMap(fakeVault({}));
    expect(serviceForHost(map, "github.com")).toBeNull();
    expect(map.size).toBe(0);
  });

  test("a configured SaaS service contributes its static host", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
    expect(serviceForHost(map, "github.com")).toBe("github");
  });

  test("an arbitrary host never resolves — no first-segment guessing", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
    // `agents/impact.ts` used to answer "github" here via a first-segment host guess before
    // it moved onto the index-based resolver. That kind of guess is acceptable as a hint
    // inside a generated brief and unacceptable as a gate on an outbound request carrying the
    // user's stored credentials.
    expect(serviceForHost(map, "github.evil.example")).toBeNull();
    expect(serviceForHost(map, "notgithub.com")).toBeNull();
    // Dot-boundary suffix matching (`host === key || host.endsWith("." + key)`) would also pass
    // both cases above yet still incorrectly resolve a subdomain of the real host.
    expect(serviceForHost(map, "api.github.com")).toBeNull();
  });

  test("a self-hosted Jenkins contributes the host of its Vault base_url", async () => {
    const map = await deriveFetchHostMap(
      fakeVault({
        "jenkins.api_token": "t",
        "jenkins.username": "u",
        "jenkins.base_url": "https://ci.corp.example:8443/jenkins/",
      }),
    );
    expect(serviceForHost(map, "ci.corp.example:8443")).toBe("jenkins");
    // The port is part of the host — a self-hosted origin is not truncated to its bare hostname.
    expect(serviceForHost(map, "ci.corp.example")).toBeNull();
  });

  test("jenkins with base_url but no credential contributes no entry", async () => {
    // base_url alone does not prove Jenkins is configured — the credential (api_token) must
    // exist too, or a stray base_url with a revoked/never-set token would be fetchable.
    const map = await deriveFetchHostMap(
      fakeVault({ "jenkins.base_url": "https://ci.corp.example:8443/" }),
    );
    expect(serviceForHost(map, "ci.corp.example:8443")).toBeNull();
    expect(map.size).toBe(0);
  });

  // IMPORTANT 2 + I29 Critical 2 (credential parity): jenkins fetchOne also requires
  // `jenkins.username` — a stray api_token+base_url with no username must contribute no entry,
  // or a partially-configured Jenkins would be claimed "configured" here while `fetchOne`
  // deterministically declines with zero network activity on every request.
  test("jenkins with api_token and base_url but no username contributes no entry", async () => {
    const map = await deriveFetchHostMap(
      fakeVault({
        "jenkins.api_token": "t",
        "jenkins.base_url": "https://ci.corp.example:8443/",
      }),
    );
    expect(serviceForHost(map, "ci.corp.example:8443")).toBeNull();
    expect(map.size).toBe(0);
  });

  test("self-hosted GitLab is reachable via api_base, not base_url", async () => {
    // The design said self-hosted GitLab was unreachable. The secret is `gitlab.api_base`.
    const map = await deriveFetchHostMap(
      fakeVault({ "gitlab.pat": "t", "gitlab.api_base": "https://git.corp.example/api/v4" }),
    );
    expect(serviceForHost(map, "git.corp.example")).toBe("gitlab");
    // IMPORTANT 2: a genuinely self-hosted-only GitLab must NOT also claim the public gitlab.com
    // host — claiming both would send a gitlab.com URL to the INTERNAL instance under the
    // internal credential.
    expect(serviceForHost(map, "gitlab.com")).toBeNull();
  });

  test("gitlab with no api_base still claims the public gitlab.com host", async () => {
    // The other direction of IMPORTANT 2's fix: absent a self-hosted origin, gitlab.com stays
    // reachable exactly as before.
    const map = await deriveFetchHostMap(fakeVault({ "gitlab.pat": "t" }));
    expect(serviceForHost(map, "gitlab.com")).toBe("gitlab");
  });

  test("a Jira base_url host is matched case-insensitively", async () => {
    // Jira's credential (api_token) proves the service is configured, independent of the
    // self-hosted origin — base_url alone (without a credential) must not resolve; see
    // "jira without a base_url secret" and "jira without a credential" below.
    const map = await deriveFetchHostMap(
      fakeVault({
        "jira.api_token": "t",
        "jira.email": "e@corp.example",
        "jira.base_url": "https://Corp.Atlassian.NET",
      }),
    );
    expect(serviceForHost(map, "corp.atlassian.net")).toBe("jira");
  });

  // I29 Critical 2 (credential parity): jira's `fetchOne` also requires `jira.email` —
  // api_token+base_url alone must contribute no entry, or a partially-configured Jira would be
  // claimed "configured" here while `fetchOne` deterministically declines with zero network
  // activity on every request.
  test("jira with api_token and base_url but no email contributes no entry", async () => {
    const map = await deriveFetchHostMap(
      fakeVault({ "jira.api_token": "t", "jira.base_url": "https://corp.atlassian.net" }),
    );
    expect(serviceForHost(map, "corp.atlassian.net")).toBeNull();
    expect(map.size).toBe(0);
  });

  // I29 Critical 2 (credential parity): bitbucket's `fetchOne` also requires
  // `bitbucket.username` — app_password alone must contribute no entry, or a
  // partially-configured Bitbucket would be claimed "configured" here while `fetchOne`
  // deterministically declines with zero network activity on every request.
  test("bitbucket with app_password but no username contributes no entry", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "bitbucket.app_password": "p" }));
    expect(serviceForHost(map, "bitbucket.org")).toBeNull();
    expect(map.size).toBe(0);
  });

  test("a malformed base_url contributes nothing rather than throwing", async () => {
    // Credential present so this exercises the origin-parse failure branch specifically, not
    // the (already-covered) missing-credential branch.
    const map = await deriveFetchHostMap(
      fakeVault({ "jenkins.api_token": "t", "jenkins.base_url": "not a url" }),
    );
    expect(map.size).toBe(0);
  });

  test("the boundary refuses what impact.ts's hint map would accept", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
    for (const host of ["github.attacker.test", "jenkins.attacker.test", "jira.attacker.test"]) {
      expect(serviceForHost(map, host)).toBeNull();
    }
  });

  test("SAAS_HOSTS is frozen and exposes exactly the three static hosts", () => {
    expect(Object.isFrozen(SAAS_HOSTS)).toBe(true);
    expect(SAAS_HOSTS).toEqual({
      "github.com": "github",
      "gitlab.com": "gitlab",
      "bitbucket.org": "bitbucket",
    });
  });

  test("a non-http(s) base_url scheme contributes nothing", async () => {
    const map = await deriveFetchHostMap(
      fakeVault({ "jenkins.api_token": "t", "jenkins.base_url": "ftp://ci.corp.example" }),
    );
    expect(map.size).toBe(0);
  });

  test("an empty-string secret is treated as not configured", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "github.pat": "" }));
    expect(serviceForHost(map, "github.com")).toBeNull();
    expect(map.size).toBe(0);
  });

  test("bitbucket is configured via app_password and exposes its static host", async () => {
    const map = await deriveFetchHostMap(
      fakeVault({ "bitbucket.username": "u", "bitbucket.app_password": "p" }),
    );
    expect(serviceForHost(map, "bitbucket.org")).toBe("bitbucket");
  });

  test("jira without a base_url secret contributes no entry", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "jira.api_token": "t" }));
    expect(map.size).toBe(0);
  });

  test("jira without a credential (base_url only) contributes no entry", async () => {
    // base_url alone does not prove Jira is configured — the credential (api_token) must exist
    // too, or a stray base_url with no live account would be fetchable. Fail-closed.
    const map = await deriveFetchHostMap(
      fakeVault({ "jira.base_url": "https://corp.atlassian.net" }),
    );
    expect(serviceForHost(map, "corp.atlassian.net")).toBeNull();
    expect(map.size).toBe(0);
  });

  test("serviceForHost is case-insensitive on the lookup side too", async () => {
    const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
    expect(serviceForHost(map, "GitHub.COM")).toBe("github");
  });

  test("a host claimed by two different services is refused for both, not last-write-wins", async () => {
    // A pasted-wrong jira.base_url pointing at github.com must not let the outbound Jira
    // credential be dispatched to github.com, and must not silently keep resolving to github
    // either — the contested host is refused entirely.
    const map = await deriveFetchHostMap(
      fakeVault({
        "github.pat": "t",
        "jira.api_token": "t",
        "jira.email": "e@corp.example",
        "jira.base_url": "https://github.com",
      }),
    );
    expect(serviceForHost(map, "github.com")).toBeNull();
  });

  test("a host contested by three services stays refused, not resolved by the last one", async () => {
    // FETCHABLE_SERVICES iterates github, gitlab, bitbucket, jenkins, jira — so with all three of
    // these configured: github claims github.com first (via SAAS_HOSTS); jenkins then claims the
    // same host via its base_url, which is the ALREADY-COVERED "detect a new collision" branch
    // (`existing !== service` → delete + ambiguousHosts.add); jira claims it last, which is the
    // UNCOVERED branch this test targets — `ambiguousHosts.has(host)` must be true and `claim()`
    // must return early, leaving the host refused rather than re-resolving to jira because jira
    // ran last.
    const map = await deriveFetchHostMap(
      fakeVault({
        "github.pat": "t",
        "jenkins.api_token": "t",
        "jenkins.username": "u",
        "jenkins.base_url": "https://github.com",
        "jira.api_token": "t",
        "jira.email": "e@corp.example",
        "jira.base_url": "https://github.com",
      }),
    );
    expect(serviceForHost(map, "github.com")).toBeNull();
  });

  test("a service re-claiming a host it already holds is not a collision", async () => {
    // gitlab.com is claimed by the static SaaS-host loop; a self-hosted origin secret that
    // happens to resolve to gitlab.com too (e.g. the api_base default) must still resolve —
    // this is the SAME service re-asserting the same host, not two services disputing it.
    const map = await deriveFetchHostMap(
      fakeVault({ "gitlab.pat": "t", "gitlab.api_base": "https://gitlab.com/api/v4" }),
    );
    expect(serviceForHost(map, "gitlab.com")).toBe("gitlab");
  });
});
