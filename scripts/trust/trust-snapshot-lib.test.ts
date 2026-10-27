import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import {
  MAX_TRUST_FEED_BYTES,
  signTrustFeed,
  signTrustStatement,
} from "../../packages/registry-format/src/index.ts";
import { runCheck } from "./check-trust-snapshot.ts";
import { runRefresh } from "./refresh-trust-snapshot.ts";
import {
  checkBakedSnapshot,
  checkFeedUrl,
  checkLiveFeed,
  compareFeeds,
  type FetchFn,
  fetchLiveFeedText,
  planRefresh,
  renderSnapshotModule,
  verifyFeedText,
} from "./trust-snapshot-lib.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 70);
const ROOT_KEY = b64(nacl.sign.keyPair.fromSeed(SEED).publicKey);
const OTHER_KEY = b64(nacl.sign.keyPair.fromSeed(OTHER_SEED).publicKey);
const CONFIG = { url: "https://trust.example.test/feed/", rootKey: ROOT_KEY };

async function feed(
  sequence: number,
  opts: { statements?: unknown[]; seed?: Uint8Array; generatedAt?: string } = {},
): Promise<string> {
  const seed = opts.seed ?? SEED;
  const signed = await signTrustFeed(
    {
      format: 1,
      rootKey: b64(nacl.sign.keyPair.fromSeed(seed).publicKey),
      sequence,
      generatedAt: opts.generatedAt ?? "2026-10-27T12:00:00.000Z",
      statements: opts.statements ?? [],
    },
    seed,
  );
  return `${JSON.stringify(signed, null, 2)}\n`;
}

/** A fetch that serves one body (or status) and records the URL and init it was called with. */
function serving(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
  return { calls, fetchFn };
}

const failing: FetchFn = async () => {
  throw new Error("offline");
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-trust-snapshot-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("renderSnapshotModule", () => {
  test("carries the text exactly, through a JSON string literal", async () => {
    const text = await feed(3);
    const module = renderSnapshotModule(text);
    expect(module).toContain("export const BAKED_TRUST_SNAPSHOT =");
    expect(module.endsWith(";\n")).toBe(true);
    const literal = module
      .slice(module.indexOf("=\n") + 2)
      .trim()
      .replace(/;$/, "");
    expect(JSON.parse(literal)).toBe(text);
  });
});

describe("checkFeedUrl", () => {
  test("accepts an https URL ending in a slash", () => {
    expect(checkFeedUrl(CONFIG.url)).toBeNull();
  });

  test("refuses a non-URL, plain http and a missing trailing slash", () => {
    expect(checkFeedUrl("not a url")).toContain("not a URL");
    expect(checkFeedUrl("http://trust.example.test/feed/")).toContain("not https");
    expect(checkFeedUrl("https://trust.example.test/feed")).toContain('end with "/"');
  });
});

describe("verifyFeedText", () => {
  test("returns the parsed feed when it verifies against the pinned key", async () => {
    expect((await verifyFeedText(await feed(4), ROOT_KEY)).sequence).toBe(4);
  });

  test("refuses a feed signed by another root, even one that names itself", async () => {
    await expect(
      verifyFeedText(await feed(4, { seed: OTHER_SEED }), ROOT_KEY),
    ).rejects.toMatchObject({ code: "ERR_TRUST_FEED_ROOT_KEY_CHANGED" });
  });

  test("refuses a tampered document", async () => {
    const tampered = (await feed(4)).replace('"sequence": 4', '"sequence": 5');
    await expect(verifyFeedText(tampered, ROOT_KEY)).rejects.toMatchObject({
      code: "ERR_TRUST_FEED_SIGNATURE_INVALID",
    });
  });

  test("refuses a document over the size cap before parsing it", async () => {
    await expect(verifyFeedText(" ".repeat(MAX_TRUST_FEED_BYTES + 1), ROOT_KEY)).rejects.toThrow(
      "over the",
    );
  });

  test("refuses a signed feed carrying statements this version cannot read", async () => {
    const text = await feed(4, { statements: [{ kind: "key.revoke" }, { kind: "future.kind" }] });
    await expect(verifyFeedText(text, ROOT_KEY)).rejects.toThrow(
      "1 malformed and 1 unknown-kind statement(s)",
    );
  });

  test("accepts a signed feed whose statements all parse", async () => {
    const statement = await signTrustStatement(
      {
        kind: "key.revoke",
        issuedAt: "2026-10-27T12:00:00Z",
        signerKey: ROOT_KEY,
        publisherId: "acme",
        keyFingerprint: "0".repeat(32),
        reason: "leaked",
      },
      SEED,
    );
    expect(
      (await verifyFeedText(await feed(4, { statements: [statement] }), ROOT_KEY)).sequence,
    ).toBe(4);
  });
});

describe("compareFeeds", () => {
  test("orders by sequence and detects a different document at the same sequence", async () => {
    const at = async (n: number, generatedAt?: string) =>
      verifyFeedText(await feed(n, generatedAt === undefined ? {} : { generatedAt }), ROOT_KEY);
    const baked = await at(2);
    expect(compareFeeds(baked, await at(2))).toBe("same");
    expect(compareFeeds(baked, await at(3))).toBe("ahead");
    expect(compareFeeds(baked, await at(1))).toBe("behind");
    expect(compareFeeds(baked, await at(2, "2026-10-28T00:00:00.000Z"))).toBe("equivocation");
  });
});

describe("fetchLiveFeedText", () => {
  test("GETs trust.json under the feed URL with no redirects and a timeout", async () => {
    const { calls, fetchFn } = serving("{}");
    expect(await fetchLiveFeedText(CONFIG, fetchFn)).toBe("{}");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://trust.example.test/feed/trust.json");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("refuses a bad URL without fetching", async () => {
    const { calls, fetchFn } = serving("{}");
    await expect(fetchLiveFeedText({ ...CONFIG, url: "http://x.test/" }, fetchFn)).rejects.toThrow(
      "not https",
    );
    expect(calls).toHaveLength(0);
  });

  test("refuses a non-2xx answer and an oversized body", async () => {
    await expect(fetchLiveFeedText(CONFIG, serving("nope", 404).fetchFn)).rejects.toThrow(
      "answered 404",
    );
    const big = serving(" ".repeat(MAX_TRUST_FEED_BYTES + 1));
    await expect(fetchLiveFeedText(CONFIG, big.fetchFn)).rejects.toThrow("over the cap");
  });
});

describe("checkBakedSnapshot", () => {
  test("a consistent feed, snapshot and module have no findings", async () => {
    const snapshot = await feed(1);
    expect(
      await checkBakedSnapshot({
        config: CONFIG,
        snapshot,
        moduleText: renderSnapshotModule(snapshot),
      }),
    ).toEqual([]);
  });

  test("a build with no feed or no snapshot is a finding", async () => {
    expect(await checkBakedSnapshot({ config: null, snapshot: null, moduleText: "" })).toEqual([
      "BUILTIN_TRUST_FEED is null: this build follows no trust feed",
    ]);
    expect(await checkBakedSnapshot({ config: CONFIG, snapshot: null, moduleText: "" })).toEqual([
      "BUILTIN_TRUST_SNAPSHOT is null: this build carries no snapshot",
    ]);
  });

  test("a bad URL, a wrong root and a hand-edited module are each reported", async () => {
    const snapshot = await feed(1, { seed: OTHER_SEED });
    const findings = await checkBakedSnapshot({
      config: { url: "https://trust.example.test/feed", rootKey: ROOT_KEY },
      snapshot,
      moduleText: `${renderSnapshotModule(snapshot)}// edited\n`,
    });
    expect(findings).toHaveLength(3);
    expect(findings[0]).toContain('end with "/"');
    expect(findings[1]).toContain("ERR_TRUST_FEED_ROOT_KEY_CHANGED");
    expect(findings[2]).toContain("trust:refresh-snapshot");
  });
});

describe("checkLiveFeed", () => {
  test("the live feed at the snapshot's sequence and content passes", async () => {
    const snapshot = await feed(2);
    expect(
      await checkLiveFeed({ config: CONFIG, snapshot, fetchFn: serving(snapshot).fetchFn }),
    ).toEqual([]);
  });

  test("ahead, behind and equivocation are each a finding", async () => {
    const snapshot = await feed(2);
    const check = async (live: string) =>
      (await checkLiveFeed({ config: CONFIG, snapshot, fetchFn: serving(live).fetchFn }))[0];
    expect(await check(await feed(3))).toContain("the snapshot is stale");
    expect(await check(await feed(1))).toContain("went BACKWARDS");
    expect(await check(await feed(2, { generatedAt: "2026-10-28T00:00:00.000Z" }))).toContain(
      "different content",
    );
  });

  test("an unreachable or unverifiable live feed is a finding", async () => {
    const snapshot = await feed(2);
    expect((await checkLiveFeed({ config: CONFIG, snapshot, fetchFn: failing }))[0]).toContain(
      "could not be read and verified (offline)",
    );
    const forged = serving(await feed(3, { seed: OTHER_SEED }));
    expect(
      (await checkLiveFeed({ config: CONFIG, snapshot, fetchFn: forged.fetchFn }))[0],
    ).toContain("ERR_TRUST_FEED_ROOT_KEY_CHANGED");
  });

  test("an unverifiable baked snapshot is reported without fetching", async () => {
    const { calls, fetchFn } = serving("{}");
    const findings = await checkLiveFeed({
      config: { ...CONFIG, rootKey: OTHER_KEY },
      snapshot: await feed(2),
      fetchFn,
    });
    expect(findings[0]).toContain("the baked snapshot does not verify");
    expect(calls).toHaveLength(0);
  });
});

describe("planRefresh", () => {
  test("a live feed ahead of the snapshot is written; the same one is unchanged", async () => {
    const snapshot = await feed(2);
    const live = await feed(3);
    expect(await planRefresh({ config: CONFIG, snapshot, liveText: live })).toEqual({
      kind: "updated",
      from: 2,
      to: 3,
      text: live,
    });
    expect(await planRefresh({ config: CONFIG, snapshot, liveText: snapshot })).toEqual({
      kind: "unchanged",
      sequence: 2,
    });
  });

  test("with no snapshot, any live feed that verifies against the baked key is written", async () => {
    const live = await feed(1);
    expect(await planRefresh({ config: CONFIG, snapshot: null, liveText: live })).toMatchObject({
      kind: "updated",
      from: 0,
      to: 1,
    });
  });

  test("refuses a rollback, an equivocation and a feed under another root", async () => {
    const snapshot = await feed(2);
    await expect(
      planRefresh({ config: CONFIG, snapshot, liveText: await feed(1) }),
    ).rejects.toThrow("refusing a rollback");
    const other = await feed(2, { generatedAt: "2026-10-28T00:00:00.000Z" });
    await expect(planRefresh({ config: CONFIG, snapshot, liveText: other })).rejects.toThrow(
      "refusing an equivocation",
    );
    await expect(
      planRefresh({ config: CONFIG, snapshot, liveText: await feed(3, { seed: OTHER_SEED }) }),
    ).rejects.toMatchObject({ code: "ERR_TRUST_FEED_ROOT_KEY_CHANGED" });
  });
});

describe("runRefresh", () => {
  function setup(moduleText: string) {
    const modulePath = join(dir, "trust-snapshot.ts");
    writeFileSync(modulePath, moduleText, { flag: "wx" });
    const lines: string[] = [];
    return { modulePath, lines, log: (l: string) => void lines.push(l) };
  }

  test("writes the module when the live feed moved ahead", async () => {
    const snapshot = await feed(1);
    const live = await feed(2);
    const s = setup(renderSnapshotModule(snapshot));
    const code = await runRefresh({
      config: CONFIG,
      snapshot,
      fetchFn: serving(live).fetchFn,
      modulePath: s.modulePath,
      log: s.log,
    });
    expect(code).toBe(0);
    expect(readFileSync(s.modulePath, "utf8")).toBe(renderSnapshotModule(live));
    expect(s.lines[0]).toContain("sequence 1 -> 2");
  });

  test("unchanged leaves a correct module alone and repairs a hand-edited one", async () => {
    const snapshot = await feed(1);
    const s = setup("// hand edited\n");
    const code = await runRefresh({
      config: CONFIG,
      snapshot,
      fetchFn: serving(snapshot).fetchFn,
      modulePath: s.modulePath,
      log: s.log,
    });
    expect(code).toBe(0);
    expect(readFileSync(s.modulePath, "utf8")).toBe(renderSnapshotModule(snapshot));
    expect(s.lines[0]).toContain("unchanged at sequence 1");
    // A second run finds the module already correct.
    expect(
      await runRefresh({
        config: CONFIG,
        snapshot,
        fetchFn: serving(snapshot).fetchFn,
        modulePath: s.modulePath,
        log: s.log,
      }),
    ).toBe(0);
  });

  test("a refusal writes nothing and exits 1", async () => {
    const snapshot = await feed(2);
    const s = setup(renderSnapshotModule(snapshot));
    const code = await runRefresh({
      config: CONFIG,
      snapshot,
      fetchFn: serving(await feed(1)).fetchFn,
      modulePath: s.modulePath,
      log: s.log,
    });
    expect(code).toBe(1);
    expect(readFileSync(s.modulePath, "utf8")).toBe(renderSnapshotModule(snapshot));
    expect(s.lines[0]).toContain("NOT refreshed: refusing a rollback");
  });

  test("a build with no feed has nothing to refresh", async () => {
    const s = setup("");
    expect(
      await runRefresh({
        config: null,
        snapshot: null,
        fetchFn: failing,
        modulePath: s.modulePath,
        log: s.log,
      }),
    ).toBe(1);
    expect(s.lines[0]).toContain("nothing to refresh");
  });
});

describe("runCheck", () => {
  async function run(over: { live?: boolean; fetchFn?: FetchFn; moduleText?: string } = {}) {
    const snapshot = await feed(1);
    const lines: string[] = [];
    const code = await runCheck({
      config: CONFIG,
      snapshot,
      moduleText: over.moduleText ?? renderSnapshotModule(snapshot),
      live: over.live ?? false,
      fetchFn: over.fetchFn ?? failing,
      log: (l) => void lines.push(l),
    });
    return { code, lines, snapshot };
  }

  test("offline: passes without touching the network", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["audit:trust-snapshot OK"]);
  });

  test("offline: a finding fails with one line per problem", async () => {
    const r = await run({ moduleText: "" });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe("audit:trust-snapshot FAILED");
    expect(r.lines[1]).toContain("trust:refresh-snapshot");
  });

  test("--live: passes when the live feed matches and fails when it moved", async () => {
    const snapshot = await feed(1);
    expect((await run({ live: true, fetchFn: serving(snapshot).fetchFn })).lines).toEqual([
      "audit:trust-snapshot OK (the live feed matches the snapshot)",
    ]);
    const moved = await run({ live: true, fetchFn: serving(await feed(2)).fetchFn });
    expect(moved.code).toBe(1);
    expect(moved.lines[1]).toContain("the snapshot is stale");
  });

  test("--live does not fetch when the offline audit already failed", async () => {
    const { calls, fetchFn } = serving("{}");
    expect((await run({ live: true, fetchFn, moduleText: "" })).code).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
