import { afterEach, describe, expect, test } from "bun:test";

import { applyBitbucketConnectorAuth } from "./auth-appliers-vcs.ts";
import type { ConnectorAuthParams } from "./auth-env.ts";

const KEYS = [
  "NIMBUS_BITBUCKET_EMAIL",
  "NIMBUS_BITBUCKET_USERNAME",
  "BITBUCKET_USERNAME",
  "NIMBUS_BITBUCKET_API_TOKEN",
  "NIMBUS_BITBUCKET_APP_PASSWORD",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const params = (): ConnectorAuthParams => ({ service: "bitbucket" }) as ConnectorAuthParams;

describe("applyBitbucketConnectorAuth env fallbacks", () => {
  test("an empty primary env var is unset, so the next one applies", () => {
    for (const k of KEYS) delete process.env[k];
    process.env["NIMBUS_BITBUCKET_EMAIL"] = "  ";
    process.env["BITBUCKET_USERNAME"] = "me@acme.test";
    process.env["NIMBUS_BITBUCKET_API_TOKEN"] = "";
    process.env["NIMBUS_BITBUCKET_APP_PASSWORD"] = "pw";
    const p = params();
    applyBitbucketConnectorAuth(p, undefined, undefined);
    expect(p.bitbucketUsername).toBe("me@acme.test");
    expect(p.personalAccessToken).toBe("pw");
  });

  test("blank flags fall back to the env, and nothing at all is refused", () => {
    for (const k of KEYS) delete process.env[k];
    process.env["NIMBUS_BITBUCKET_EMAIL"] = "me@acme.test";
    process.env["NIMBUS_BITBUCKET_API_TOKEN"] = "tok";
    const p = params();
    applyBitbucketConnectorAuth(p, " ", "");
    expect([p.bitbucketUsername, p.personalAccessToken]).toEqual(["me@acme.test", "tok"]);
    for (const k of KEYS) delete process.env[k];
    expect(() => applyBitbucketConnectorAuth(params(), undefined, undefined)).toThrow(
      /Atlassian email/,
    );
  });
});
