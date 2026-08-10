import { expect, test } from "bun:test";

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
