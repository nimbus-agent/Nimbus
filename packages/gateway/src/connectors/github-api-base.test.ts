import { describe, expect, test } from "bun:test";

import {
  GITHUB_DEFAULT_REST_ROOT,
  GITHUB_DEFAULT_WEB_ORIGIN,
  normaliseGithubApiBase,
  readGithubCredentialPair,
  resolveGithubBase,
} from "./github-api-base.ts";

function ok(raw: string): { base: string; host: string } {
  const r = normaliseGithubApiBase(raw);
  if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.reason}`);
  return r;
}

function reason(raw: string): string {
  const r = normaliseGithubApiBase(raw);
  if (r.ok) throw new Error(`expected refusal for ${raw}`);
  return r.reason;
}

describe("normaliseGithubApiBase", () => {
  test("accepts the four spellings and returns https://ghe.example.com/api/v3", () => {
    for (const raw of [
      "https://ghe.example.com",
      "https://ghe.example.com/",
      "https://ghe.example.com/api/v3",
      "https://ghe.example.com/api/v3/",
    ]) {
      expect(ok(raw).base).toBe("https://ghe.example.com/api/v3");
    }
  });

  test("keeps an explicit port and puts it in host as host:port", () => {
    const r = ok("https://ghe.example.com:8443/api/v3");
    expect(r.host).toBe("ghe.example.com:8443");
    expect(r.base).toBe("https://ghe.example.com:8443/api/v3");
  });

  test("lowercases the host and drops a trailing dot", () => {
    expect(ok("HTTPS://GHE.Example.COM./api/v3").host).toBe("ghe.example.com");
  });

  test("converts a Unicode host to punycode before checking", () => {
    expect(ok("https://bücher.example.com").host).toBe("xn--bcher-kva.example.com");
  });

  test("refuses http, with a reason that does not contain the input", () => {
    const input = "http://ghe.secret-name.example.com";
    const r = reason(input);
    expect(r).toContain("https");
    expect(r).not.toContain("secret-name");
  });

  test("refuses credentials in the URL (user, user:pass)", () => {
    expect(reason("https://user@ghe.example.com")).toContain("credentials");
    expect(reason("https://user:pw@ghe.example.com")).toContain("credentials");
  });

  test("refuses a query string and a fragment", () => {
    expect(reason("https://ghe.example.com/api/v3?x=1")).toContain("query");
    expect(reason("https://ghe.example.com/api/v3#frag")).toContain("query");
    expect(reason("https://ghe.example.com/?")).toContain("query");
  });

  test("refuses a path other than empty, / or /api/v3 (including /api/v4 and /api/v3/x)", () => {
    for (const raw of [
      "https://ghe.example.com/api/v4",
      "https://ghe.example.com/api/v3/x",
      "https://ghe.example.com/foo",
    ]) {
      expect(reason(raw)).toContain("path");
    }
  });

  test("refuses github.com, api.github.com and *.ghe.com (case and trailing dot included)", () => {
    expect(reason("https://github.com")).toContain("default");
    expect(reason("HTTPS://GitHub.COM")).toContain("default");
    expect(reason("https://api.github.com/")).toContain("default");
    expect(reason("https://acme.ghe.com")).toContain("GHE.com");
    expect(reason("https://x.ghe.com./api/v3")).toContain("GHE.com");
  });

  test("refuses loopback, unspecified and link-local hosts", () => {
    for (const raw of [
      "https://localhost",
      "https://localhost.",
      "https://127.0.0.1",
      "https://127.9.9.9:8443",
      "https://0.0.0.0",
      "https://0.1.2.3",
      "https://evil.localhost",
      "https://LOCALHOST.",
      "https://a.b.localhost.:8443",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[fe80::1]",
    ]) {
      expect(normaliseGithubApiBase(raw).ok).toBe(false);
    }
  });

  test("allows RFC 1918 private addresses (a corporate appliance behind a VPN)", () => {
    expect(ok("https://10.1.2.3").base).toBe("https://10.1.2.3/api/v3");
    expect(ok("https://192.168.0.5:8443").host).toBe("192.168.0.5:8443");
  });

  test("refuses an IPv6 literal and a host with whitespace or control characters", () => {
    expect(reason("https://[2001:db8::1]")).toContain("IPv6");
    expect(normaliseGithubApiBase("https://ghe.exa mple.com").ok).toBe(false);
    expect(normaliseGithubApiBase("https://ghe.example.com/\u0000").ok).toBe(false);
    expect(normaliseGithubApiBase("https://ghe.example.com\n/api/v3").ok).toBe(false);
  });

  test("refuses an empty or whitespace value", () => {
    expect(normaliseGithubApiBase("").ok).toBe(false);
    expect(normaliseGithubApiBase("   ").ok).toBe(false);
  });

  test("a success always re-normalises to itself (idempotent)", () => {
    for (const raw of [
      "https://ghe.example.com",
      "https://GHE.example.com:8443/api/v3/",
      "https://10.0.0.1/",
    ]) {
      const first = ok(raw);
      const again = ok(first.base);
      expect(again.base).toBe(first.base);
      expect(again.host).toBe(first.host);
    }
  });
});

describe("resolveGithubBase", () => {
  test("absent means github.com", () => {
    for (const absent of [null, undefined]) {
      const r = resolveGithubBase(absent);
      expect(r).toEqual({
        ok: true,
        restRoot: GITHUB_DEFAULT_REST_ROOT,
        webOrigin: GITHUB_DEFAULT_WEB_ORIGIN,
        host: null,
      });
    }
  });

  test("a valid stored base resolves to its REST root and web origin", () => {
    expect(resolveGithubBase("https://ghe.example.com/api/v3")).toEqual({
      ok: true,
      restRoot: "https://ghe.example.com/api/v3",
      webOrigin: "https://ghe.example.com",
      host: "ghe.example.com",
    });
  });

  test("a present but invalid stored base FAILS CLOSED, never the default", () => {
    for (const bad of [
      "",
      "   ",
      "http://ghe.example.com",
      "https://u:p@ghe.example.com",
      "junk",
    ]) {
      expect(resolveGithubBase(bad)).toEqual({ ok: false });
    }
  });
});

describe("readGithubCredentialPair", () => {
  function reader(bases: Array<string | null>, pat: string | null) {
    let baseReads = 0;
    const order: string[] = [];
    const get = async (key: "pat" | "api_base"): Promise<string | null> => {
      order.push(key);
      if (key === "pat") return pat;
      const v = bases[Math.min(baseReads, bases.length - 1)] ?? null;
      baseReads += 1;
      return v;
    };
    return { get, order };
  }

  test("reads the base, the PAT, then the base again", async () => {
    const r = reader(["https://ghe.example.com"], "tok");
    const pair = await readGithubCredentialPair(r.get);
    expect(r.order).toEqual(["api_base", "pat", "api_base"]);
    expect(pair.kind).toBe("ok");
    if (pair.kind === "ok") {
      expect(pair.pat).toBe("tok");
      expect(pair.base.restRoot).toBe("https://ghe.example.com/api/v3");
    }
  });

  test("a stable absent base is github.com", async () => {
    const pair = await readGithubCredentialPair(reader([null], "tok").get);
    expect(pair.kind === "ok" && pair.base.restRoot).toBe(GITHUB_DEFAULT_REST_ROOT);
  });

  test("a base that changes between the two reads is unstable (no pair)", async () => {
    expect(
      await readGithubCredentialPair(reader([null, "https://ghe.example.com"], "tok").get),
    ).toEqual({ kind: "unstable" });
    expect(
      await readGithubCredentialPair(reader(["https://ghe.example.com", null], "tok").get),
    ).toEqual({ kind: "unstable" });
  });

  test("a present but invalid base is invalid", async () => {
    expect(await readGithubCredentialPair(reader(["http://x.example.com"], "tok").get)).toEqual({
      kind: "invalid",
    });
  });
});
