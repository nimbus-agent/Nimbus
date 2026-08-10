import { expect, test } from "bun:test";

import { basicAuthHeader } from "./atlassian-api-sync-helpers.ts";
import {
  CREDENTIAL_PROBES,
  runCredentialProbe,
  verdictForProbeResponse,
} from "./credential-probe.ts";

test("200 is valid", () => {
  expect(verdictForProbeResponse(200)).toEqual({ kind: "valid" });
});

test("401 is the ONLY rejecting status", () => {
  expect(verdictForProbeResponse(401)).toEqual({ kind: "rejected", httpStatus: 401 });
});

// A 403 means the provider knows who you are and declined THIS endpoint — the
// credential authenticated. A GitHub fine-grained PAT scoped to repositories but
// not account metadata 403s on /user while working for everything Nimbus needs.
// Rejecting it would be the same over-claim, pointed the other way.
test("403 is unverified, never rejected", () => {
  expect(verdictForProbeResponse(403)).toEqual({ kind: "unreachable" });
});

test("429 and 5xx are unverified, never rejected", () => {
  expect(verdictForProbeResponse(429)).toEqual({ kind: "unreachable" });
  expect(verdictForProbeResponse(500)).toEqual({ kind: "unreachable" });
  expect(verdictForProbeResponse(503)).toEqual({ kind: "unreachable" });
});

test("a transport failure is unreachable, and the exception never escapes", async () => {
  const verdict = await runCredentialProbe("github", { pat: "t" }, () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
  });
  expect(verdict).toEqual({ kind: "unreachable" });
});

test("a service with no registered probe returns null", async () => {
  expect(CREDENTIAL_PROBES["datadog"]).toBeUndefined();
  expect(await runCredentialProbe("datadog", { api_key: "k" })).toBeNull();
});

test("github probes /user with a bearer header and an abort signal", async () => {
  let seenUrl = "";
  let seenAuth = "";
  let hadSignal = false;
  await runCredentialProbe("github", { pat: "pat-value" }, (url, init) => {
    seenUrl = String(url);
    seenAuth = String(((init?.headers ?? {}) as Record<string, string>)["Authorization"]);
    hadSignal = init?.signal !== undefined;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  expect(seenUrl).toBe("https://api.github.com/user");
  expect(seenAuth).toBe("Bearer pat-value");
  // Without a bound signal, `nimbus connector auth` hangs on a stalled provider.
  expect(hadSignal).toBe(true);
});

test("every registered probe builds an absolute https url", () => {
  const creds = {
    pat: "t",
    username: "u",
    app_password: "p",
    api_token: "t",
    email: "e@example.com",
    base_url: "https://ci.example.com",
    api_base: "https://gitlab.example.com/api/v4",
  };
  for (const [service, probe] of Object.entries(CREDENTIAL_PROBES)) {
    const req = (probe as (c: Record<string, string>) => { url: string })(creds);
    expect(new URL(req.url).protocol, `${service} probe scheme`).toBe("https:");
  }
});

test("a base url with whitespace and a trailing slash normalizes like auth.ts stores it", () => {
  const jenkinsProbe = CREDENTIAL_PROBES["jenkins"];
  expect(jenkinsProbe).toBeDefined();
  const jenkinsReq = jenkinsProbe?.({
    base_url: "  https://ci.example.com/  ",
    username: "u",
    api_token: "t",
  });
  expect(jenkinsReq?.url).toBe("https://ci.example.com/api/json");

  const jiraProbe = CREDENTIAL_PROBES["jira"];
  expect(jiraProbe).toBeDefined();
  const jiraReq = jiraProbe?.({
    base_url: "  https://jira.example.com/  ",
    email: "e@example.com",
    api_token: "t",
  });
  expect(jiraReq?.url).toBe("https://jira.example.com/rest/api/3/myself");
});

// Every probe reads its credential fields with `?? ""` (or, for gitlab's `api_base`, `??
// "https://gitlab.com/api/v4"`). These fallback branches only run when a field is ACTUALLY
// missing — a request built from a stored credential the caller never supplied a value for —
// which none of the tests above exercise (they always pass a fully-populated `creds` object).
// `probe({})` is a legitimate call shape: `connector.auth`'s handler builds `creds` from
// whatever the CLI flags/prompts actually supplied, and a partially-filled form is not a
// programming error the probe gets to assume away.
test("github's Authorization falls back to an empty PAT when pat is missing", () => {
  const req = CREDENTIAL_PROBES["github"]?.({});
  expect(req?.headers["Authorization"]).toBe("Bearer ");
});

test("gitlab falls back to the public gitlab.com api_base and an empty PAT when both are missing", () => {
  const req = CREDENTIAL_PROBES["gitlab"]?.({});
  expect(req?.url).toBe("https://gitlab.com/api/v4/user");
  expect(req?.headers["PRIVATE-TOKEN"]).toBe("");
});

test("bitbucket falls back to an empty username/app_password when both are missing", () => {
  const req = CREDENTIAL_PROBES["bitbucket"]?.({});
  expect(req?.headers["Authorization"]).toBe(basicAuthHeader("", ""));
});

test("jira falls back to an empty base_url/email/api_token when all three are missing", () => {
  const req = CREDENTIAL_PROBES["jira"]?.({});
  expect(req?.url).toBe("/rest/api/3/myself");
  expect(req?.headers["Authorization"]).toBe(basicAuthHeader("", ""));
});

test("jenkins falls back to an empty base_url/username/api_token when all three are missing", () => {
  const req = CREDENTIAL_PROBES["jenkins"]?.({});
  expect(req?.url).toBe("/api/json");
  expect(req?.headers["Authorization"]).toBe(basicAuthHeader("", ""));
});
