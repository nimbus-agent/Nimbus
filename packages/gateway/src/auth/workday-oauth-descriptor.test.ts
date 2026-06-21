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
  test("throws when tenant config is empty", () => {
    expect(() => makeWorkdayDescriptor({ tenantHost: "", tenant: "acme" })).toThrow(/tenant/i);
  });
});
