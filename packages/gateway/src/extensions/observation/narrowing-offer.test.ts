import { describe, expect, test } from "bun:test";

import { narrowNetwork } from "../extension-run-grants.ts";
import {
  type NarrowingOfferInput,
  narrowingOffer,
  OFFER_MIN_DAYS,
  OFFER_MIN_RUNS,
  type OfferCoverage,
} from "./narrowing-offer.ts";

const ENOUGH: OfferCoverage = {
  networkObserved: true,
  runs: OFFER_MIN_RUNS,
  observedDays: OFFER_MIN_DAYS,
  dropped: 0,
  stopped: false,
};

function input(over: Partial<NarrowingOfferInput> = {}): NarrowingOfferInput {
  const declaredRaw = over.declaredRaw ?? ["api.example.com", "imap.example.com:993"];
  return {
    os: "linux",
    declaredRaw,
    approved: declaredRaw,
    coverage: ENOUGH,
    used: [],
    unmatched: [],
    installedVersion: "1.0.0",
    coverageVersion: "1.0.0",
    ...over,
  };
}

const USED_API = [{ destination: "api.example.com", port: 443 }];

describe("narrowingOffer: Linux removes declared host:port entries not seen used", () => {
  test("a bare host means :443; the unseen entry goes, as its raw manifest string", () => {
    expect(narrowingOffer(input({ used: USED_API }))).toEqual({
      keep: ["api.example.com"],
      remove: ["imap.example.com:993"],
      runs: OFFER_MIN_RUNS,
      days: OFFER_MIN_DAYS,
    });
  });

  test("a used name in another spelling (case, trailing dot) still keeps its entry", () => {
    const used = [{ destination: "API.Example.com.", port: 443 }];
    expect(narrowingOffer(input({ used }))?.keep).toEqual(["api.example.com"]);
  });

  test("the same host on a port that was not used does not keep the entry", () => {
    const used = [{ destination: "imap.example.com", port: 443 }];
    expect(narrowingOffer(input({ used }))).toMatchObject({
      keep: [],
      remove: ["api.example.com", "imap.example.com:993"],
    });
  });

  test("a refused or unmatched row keeps nothing on Linux", () => {
    const o = narrowingOffer(
      input({ used: USED_API, unmatched: [{ destination: "1.2.3.4", port: 993 }] }),
    );
    expect(o?.keep).toEqual(["api.example.com"]);
  });

  test("the offered list is exactly what the approval's narrowNetwork accepts and stores", () => {
    const declaredRaw = ["api.example.com", "api.example.com:8443", "imap.example.com:993"];
    const o = narrowingOffer(input({ declaredRaw, used: USED_API }));
    expect(o?.keep).toEqual(["api.example.com"]);
    const narrowed = narrowNetwork({ network: declaredRaw, read: [], write: [] }, o?.keep ?? []);
    expect(narrowed).toEqual(o?.keep ?? []);
  });
});

describe("narrowingOffer: macOS removes whole ports only", () => {
  const declaredRaw = ["api.example.com", "cdn.example.com:443", "imap.example.com:993"];

  test("an entry on a port nobody used goes; a host on a used port stays", () => {
    expect(narrowingOffer(input({ os: "darwin", declaredRaw, used: USED_API }))).toMatchObject({
      keep: ["api.example.com", "cdn.example.com:443"],
      remove: ["imap.example.com:993"],
    });
  });

  test("an unmatched connection on a port keeps every entry on that port", () => {
    const unmatched = [{ destination: "203.0.113.7", port: 993 }];
    const o = narrowingOffer(input({ os: "darwin", declaredRaw, used: USED_API, unmatched }));
    expect(o).toBeNull();
  });

  test("no port goes (only a host whose port stays): no offer", () => {
    const d = ["api.example.com", "cdn.example.com"];
    expect(narrowingOffer(input({ os: "darwin", declaredRaw: d, used: USED_API }))).toBeNull();
  });
});

describe("narrowingOffer: Windows offers no network at all, only with nothing seen", () => {
  test("zero used and zero unmatched: keep nothing, remove everything approved", () => {
    expect(narrowingOffer(input({ os: "win32" }))).toMatchObject({
      keep: [],
      remove: ["api.example.com", "imap.example.com:993"],
    });
  });

  test("one used connection: no offer (never no network while it was seen connecting)", () => {
    expect(narrowingOffer(input({ os: "win32", used: USED_API }))).toBeNull();
  });

  test("one unmatched connection: no offer", () => {
    const unmatched = [{ destination: "203.0.113.7", port: 443 }];
    expect(narrowingOffer(input({ os: "win32", unmatched }))).toBeNull();
  });
});

describe("narrowingOffer: the minimum evidence window", () => {
  const cases: Array<[string, Partial<NarrowingOfferInput>]> = [
    ["4 runs", { coverage: { ...ENOUGH, runs: OFFER_MIN_RUNS - 1 } }],
    ["6 days", { coverage: { ...ENOUGH, observedDays: OFFER_MIN_DAYS - 1 } }],
    ["1 dropped", { coverage: { ...ENOUGH, dropped: 1 } }],
    ["a stopped run", { coverage: { ...ENOUGH, stopped: true } }],
    ["network not observed", { coverage: { ...ENOUGH, networkObserved: false } }],
    ["no coverage", { coverage: undefined, coverageVersion: undefined }],
    ["an older version's evidence", { coverageVersion: "0.9.0" }],
  ];
  for (const [name, over] of cases) {
    test(`${name}: no offer`, () => {
      expect(narrowingOffer(input({ used: USED_API, ...over }))).toBeNull();
    });
  }

  test("the same input with the window met does offer (the gates above are what refuse)", () => {
    expect(narrowingOffer(input({ used: USED_API }))).not.toBeNull();
  });
});

describe("narrowingOffer: never equal to or wider than what is approved", () => {
  test("everything declared was used: nothing removable, no offer", () => {
    const used = [...USED_API, { destination: "imap.example.com", port: 993 }];
    expect(narrowingOffer(input({ used }))).toBeNull();
  });

  test("a grant already narrowed to exactly what was used: no offer", () => {
    expect(narrowingOffer(input({ approved: ["api.example.com"], used: USED_API }))).toBeNull();
  });

  test("a grant narrowed below what was used: no offer that would widen it", () => {
    const declaredRaw = ["api.example.com", "cdn.example.com:443", "imap.example.com:993"];
    const o = narrowingOffer(
      input({ os: "darwin", declaredRaw, approved: ["api.example.com"], used: USED_API }),
    );
    expect(o).toBeNull();
  });

  test("a narrowed grant that can go further: the offer is computed against the manifest", () => {
    const declaredRaw = ["api.example.com", "cdn.example.com:8443", "imap.example.com:993"];
    const o = narrowingOffer(
      input({ declaredRaw, approved: ["api.example.com", "cdn.example.com:8443"], used: USED_API }),
    );
    expect(o).toMatchObject({ keep: ["api.example.com"], remove: ["cdn.example.com:8443"] });
  });

  test("a host used earlier but narrowed away is not offered back, and blocks nothing", () => {
    // Evidence from before the narrowing, same version: api was used, then narrowed away.
    const declaredRaw = ["api.example.com", "cdn.example.com:8443", "imap.example.com:993"];
    const approved = ["cdn.example.com:8443", "imap.example.com:993"];
    const used = [...USED_API, { destination: "cdn.example.com", port: 8443 }];
    expect(narrowingOffer(input({ declaredRaw, approved, used }))).toMatchObject({
      keep: ["cdn.example.com:8443"],
      remove: ["imap.example.com:993"],
    });
  });

  test("only narrowed-away hosts were used: the offer keeps nothing, never re-adds them", () => {
    const declaredRaw = ["api.example.com", "cdn.example.com:8443", "imap.example.com:993"];
    const approved = ["cdn.example.com:8443", "imap.example.com:993"];
    expect(narrowingOffer(input({ declaredRaw, approved, used: USED_API }))).toMatchObject({
      keep: [],
      remove: ["cdn.example.com:8443", "imap.example.com:993"],
    });
  });

  test("keep is in manifest order and every entry is one the grant approves (another spelling)", () => {
    const declaredRaw = ["api.example.com", "cdn.example.com:8443", "imap.example.com:993"];
    const approved = ["imap.example.com:993", "API.example.com:443", "cdn.example.com:8443"];
    const used = [
      { destination: "imap.example.com", port: 993 },
      { destination: "api.example.com", port: 443 },
    ];
    const o = narrowingOffer(input({ declaredRaw, approved, used }));
    expect(o).toMatchObject({
      keep: ["api.example.com", "imap.example.com:993"],
      remove: ["cdn.example.com:8443"],
    });
  });

  test("an empty approved grant: nothing to narrow", () => {
    expect(narrowingOffer(input({ os: "win32", approved: [] }))).toBeNull();
  });
});
