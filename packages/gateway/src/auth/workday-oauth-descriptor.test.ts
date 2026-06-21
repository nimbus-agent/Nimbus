import { describe, expect, test } from "bun:test";
import { makeWorkdayDescriptor } from "./workday-oauth-descriptor.ts";

describe("makeWorkdayDescriptor", () => {
  test("interpolates tenant-specific authorize/token urls", () => {
    const d = makeWorkdayDescriptor({ tenantHost: "https://wd5.workday.com/", tenant: "acme" });
    expect(d.authorizeUrl).toBe("https://wd5.workday.com/ccx/oauth2/acme/authorize");
    expect(d.tokenUrl).toBe("https://wd5.workday.com/ccx/oauth2/acme/token");
    expect(d.vaultKey).toBe("workday.oauth");
    expect(d.id).toBe("workday");
    expect(d.clientSecret).toBe("required");
  });
  test("throws when tenant host is empty", () => {
    expect(() => makeWorkdayDescriptor({ tenantHost: "", tenant: "acme" })).toThrow(/tenant/i);
  });
  test("throws when tenant name is empty (covers the second throw operand)", () => {
    expect(() =>
      makeWorkdayDescriptor({ tenantHost: "https://wd5.workday.com", tenant: "" }),
    ).toThrow(/tenant/i);
  });

  test("throws when tenant host is not an absolute URL (new URL throws)", () => {
    // A bare hostname without a scheme is not an absolute URL — fail fast here rather
    // than producing opaque authorize/token-URL errors deep in the OAuth flow.
    expect(() => makeWorkdayDescriptor({ tenantHost: "notaurl", tenant: "acme" })).toThrow(
      /not an absolute URL/i,
    );
  });

  test("throws when tenant host scheme is not http(s)", () => {
    expect(() =>
      makeWorkdayDescriptor({ tenantHost: "ftp://wd5.workday.com", tenant: "acme" }),
    ).toThrow(/must be an http\(s\) URL/i);
  });

  test("accepts a plain http tenant host (both protocol arms valid)", () => {
    const d = makeWorkdayDescriptor({ tenantHost: "http://localhost:8080", tenant: "acme" });
    expect(d.authorizeUrl).toBe("http://localhost:8080/ccx/oauth2/acme/authorize");
    expect(d.tokenUrl).toBe("http://localhost:8080/ccx/oauth2/acme/token");
  });
});
