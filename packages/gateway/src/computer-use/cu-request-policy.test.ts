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

  test('M11: an opaque-origin scheme returns the literal string "null", not the JS value null', () => {
    // `new URL(...).origin` returns the STRING "null" for javascript:/data:/about:/file: — a
    // parseable URL with no serializable origin. originOf does not special-case this; it is
    // fail-closed only by exact-match accident against a real stored origin, never by an explicit
    // check. This test pins the actual behaviour so the doc comment cannot misstate it again.
    expect(originOf("javascript:alert(1)")).toBe("null");
    expect(originOf("data:text/plain,hi")).toBe("null");
    expect(originOf("about:blank")).toBe("null");
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

  test("I9: refuses embedded userinfo (the canonical look-alike origin)", () => {
    // `https://example.com@evil.com` parses to origin `https://evil.com` with username
    // "example.com" — a human reading the typed string sees "example.com" first and could easily
    // approve what is actually a grant for evil.com. Refuse rather than reduce, exactly like the
    // path/query/fragment rule above.
    expect(normalizeOrigin("https://example.com@evil.com")).toBeNull();
    expect(normalizeOrigin("https://user:pass@example.com")).toBeNull();
  });

  test("M12: refuses a trailing dot on the hostname", () => {
    // `https://example.com.` is a distinct string from `https://example.com` that a live request
    // never produces, so a stored origin with a trailing dot can never match anything real.
    expect(normalizeOrigin("https://example.com.")).toBeNull();
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
    const result = decide("document", "https://example.com/page");
    expect(result.allow).toBe(true);
    expect(result.reason).toContain("navigation origin approved");
  });

  test("refuses a navigation outside navigateOrigins", () => {
    const result = decide("document", "https://evil.com/page");
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("evil.com");
  });

  test("a scriptOrigin does NOT grant navigation", () => {
    // The two sets are not interchangeable: scriptOrigins is for subresource APIs, and folding it
    // into navigation would let an approved API host become a page the agent can be steered to.
    expect(decide("document", "https://api.example.com/x").allow).toBe(false);
  });
});

describe("decideRequest — sub_frame (I10: not exercised by the original suite)", () => {
  test("allows a sub_frame navigation inside navigateOrigins", () => {
    expect(decide("sub_frame", "https://example.com/iframe").allow).toBe(true);
  });

  test("refuses a sub_frame navigation outside navigateOrigins", () => {
    expect(decide("sub_frame", "https://evil.com/iframe").allow).toBe(false);
  });

  test("a scriptOrigin does NOT grant a sub_frame navigation either", () => {
    // Without this, deleting `|| resourceType === "sub_frame"` from the document branch stays
    // green, and an approved API host can be framed as a page.
    expect(decide("sub_frame", "https://api.example.com/iframe").allow).toBe(false);
  });
});

describe("decideRequest — script-initiated requests", () => {
  test.each<CuResourceType>(["xhr", "fetch", "eventsource", "websocket"])(
    "%s to an unapproved origin is REFUSED",
    (rt) => {
      expect(decide(rt, "https://evil.com/collect").allow).toBe(false);
    },
  );

  test.each<CuResourceType>(["xhr", "fetch", "eventsource"])(
    "%s to a scriptOrigin is allowed",
    (rt) => {
      const result = decide(rt, "https://api.example.com/v1");
      expect(result.allow).toBe(true);
      expect(result.reason).toContain(rt);
    },
  );

  test("fetch to a navigateOrigin is allowed (the union, not just scriptOrigins)", () => {
    expect(decide("fetch", "https://example.com/api").allow).toBe(true);
  });
});

describe("decideRequest — I8: websocket origin mapping (CDP reports ws(s):// origins)", () => {
  // The original "websocket to a scriptOrigin is allowed" test used an https:// URL — a shape CDP
  // never produces for a websocket — which is why it could not catch this. `originOf` on a real
  // `wss://` URL yields `wss://api.example.com`, which never equals a stored `https://` origin
  // without an explicit mapping.
  test("a real wss:// websocket URL matches an https scriptOrigin", () => {
    const result = decide("websocket", "wss://api.example.com/socket");
    expect(result.allow).toBe(true);
  });

  test("a real ws:// websocket URL matches an http navigateOrigin", () => {
    const t: CuBrowserTarget = { navigateOrigins: ["http://example.com"], scriptOrigins: [] };
    expect(
      decideRequest({ resourceType: "websocket", url: "ws://example.com/socket", target: t }).allow,
    ).toBe(true);
  });

  test("a wss:// websocket to an unapproved origin is still refused", () => {
    expect(decide("websocket", "wss://evil.com/socket").allow).toBe(false);
  });

  test("normalizeOrigin is NOT loosened to accept a ws(s): scheme — the owner approves https, the upgrade rides on it", () => {
    expect(normalizeOrigin("wss://example.com")).toBeNull();
    expect(normalizeOrigin("ws://example.com")).toBeNull();
  });
});

describe("decideRequest — passive subresources", () => {
  test.each<CuResourceType>(["stylesheet", "image", "font", "media", "script"])(
    "%s loads from ANY origin — the documented bound, not an oversight",
    (rt) => {
      // Spec § 3.5.1 + § 13 bound 3: blocking these breaks the real web, so an <img>/<script src>
      // beacon survives. This test PINS the bound so a later reader cannot mistake the policy for
      // a closed exfiltration boundary.
      const result = decide(rt, "https://evil.com/beacon.png?d=secret");
      expect(result.allow).toBe(true);
      expect(result.reason).toContain("passive subresource");
    },
  );
});

describe("decideRequest — fail-closed", () => {
  test("an unparseable url is refused for a gated type", () => {
    const result = decide("fetch", "not a url");
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("unparseable url");
  });

  test("an unknown resource type is treated as gated, not as passive", () => {
    const result = decide("other", "https://evil.com/x");
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("evil.com");
  });
});
