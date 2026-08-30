import { describe, expect, test } from "bun:test";
import {
  type CuResourceType,
  decideRequest,
  normalizeOrigin,
  originOf,
} from "./cu-request-policy.ts";
import type { CuBrowserTarget } from "./cu-types.ts";

const target: CuBrowserTarget = {
  navigateOrigins: ["https://example.com"],
  scriptOrigins: ["https://api.example.com"],
};

const decide = (resourceType: CuResourceType, url: string) =>
  decideRequest({ resourceType, url, target });

describe("originOf", () => {
  test("extracts scheme+host+port", () => {
    expect(originOf("https://example.com/a/b?c=1")).toBe("https://example.com");
    expect(originOf("https://example.com:8443/x")).toBe("https://example.com:8443");
  });

  test("returns null for an unparseable url rather than guessing", () => {
    expect(originOf("not a url")).toBeNull();
  });
});

describe("normalizeOrigin", () => {
  test("canonicalises case and a trailing slash", () => {
    // Without this, an exact `.includes` compares a human-typed string against a URL-derived one
    // and refuses every navigation to an origin the owner DID approve.
    expect(normalizeOrigin("https://Example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("https://EXAMPLE.com")).toBe("https://example.com");
  });

  test("elides the default port but keeps a non-default one", () => {
    expect(normalizeOrigin("https://example.com:443")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
  });

  test("REFUSES a path rather than silently widening it to the whole origin", () => {
    // `new URL()` would turn this into `https://example.com` — BROADER than what was typed. The
    // owner scoped to a subdirectory; silently granting the whole site is the wrong direction to
    // guess in, so it is refused at the point the mistake is made.
    expect(normalizeOrigin("https://example.com/safe/subdir")).toBeNull();
    expect(normalizeOrigin("https://example.com/?q=1")).toBeNull();
    expect(normalizeOrigin("https://example.com/#frag")).toBeNull();
  });

  test("refuses a non-http(s) scheme", () => {
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
  });

  test("refuses garbage", () => {
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});

describe("decideRequest — normalised origins match", () => {
  test("a request matches an origin the owner typed with different casing", () => {
    const t = {
      navigateOrigins: [normalizeOrigin("https://Example.com/") as string],
      scriptOrigins: [],
    };
    expect(
      decideRequest({ resourceType: "document", url: "https://example.com/p", target: t }).allow,
    ).toBe(true);
  });
});

describe("decideRequest — documents", () => {
  test("allows a navigation inside navigateOrigins", () => {
    expect(decide("document", "https://example.com/page").allow).toBe(true);
  });

  test("refuses a navigation outside navigateOrigins", () => {
    expect(decide("document", "https://evil.com/page").allow).toBe(false);
  });

  test("a scriptOrigin does NOT grant navigation", () => {
    // The two sets are not interchangeable: scriptOrigins is for subresource APIs, and folding it
    // into navigation would let an approved API host become a page the agent can be steered to.
    expect(decide("document", "https://api.example.com/x").allow).toBe(false);
  });
});

describe("decideRequest — script-initiated requests", () => {
  test.each<CuResourceType>(["xhr", "fetch", "eventsource", "websocket"])(
    "%s to an unapproved origin is REFUSED",
    (rt) => {
      expect(decide(rt, "https://evil.com/collect").allow).toBe(false);
    },
  );

  test.each<CuResourceType>(["xhr", "fetch", "eventsource", "websocket"])(
    "%s to a scriptOrigin is allowed",
    (rt) => {
      expect(decide(rt, "https://api.example.com/v1").allow).toBe(true);
    },
  );

  test("fetch to a navigateOrigin is allowed (the union, not just scriptOrigins)", () => {
    expect(decide("fetch", "https://example.com/api").allow).toBe(true);
  });
});

describe("decideRequest — passive subresources", () => {
  test.each<CuResourceType>(["stylesheet", "image", "font", "media", "script"])(
    "%s loads from ANY origin — the documented bound, not an oversight",
    (rt) => {
      // Spec § 3.5.1 + § 13 bound 3: blocking these breaks the real web, so an <img>/<script src>
      // beacon survives. This test PINS the bound so a later reader cannot mistake the policy for
      // a closed exfiltration boundary.
      expect(decide(rt, "https://evil.com/beacon.png?d=secret").allow).toBe(true);
    },
  );
});

describe("decideRequest — fail-closed", () => {
  test("an unparseable url is refused for a gated type", () => {
    expect(decide("fetch", "not a url").allow).toBe(false);
  });

  test("an unknown resource type is treated as gated, not as passive", () => {
    expect(decide("other", "https://evil.com/x").allow).toBe(false);
  });
});
