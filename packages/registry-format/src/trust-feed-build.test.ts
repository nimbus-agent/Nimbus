import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { publisherKeyFingerprint } from "./fingerprint.ts";
import { alreadyCarried, signFeedRequest } from "./registry-requests.ts";
import {
  parseTrustFeed,
  readTrustFeedStatements,
  signTrustFeed,
  type TrustFeed,
  verifyTrustFeedPinned,
} from "./trust-feed.ts";
import {
  buildTrustFeed,
  emptyTrustFeed,
  type FeedSource,
  type FeedSourceFile,
  parseFeedConfig,
  parsePublisherFile,
  planTrustFeed,
} from "./trust-feed-build.ts";
import {
  signTrustStatement,
  type TrustStatement,
  trustStatementId,
  verifyTrustStatement,
} from "./trust-statement.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const keyOf = (seed: Uint8Array): string => b64(nacl.sign.keyPair.fromSeed(seed).publicKey);
const ROOT_SEED = new Uint8Array(32).fill(91);
const ROOT_KEY = keyOf(ROOT_SEED);
const OTHER_SEED = new Uint8Array(32).fill(92);
const PUB_SEED = new Uint8Array(32).fill(93);
const PUB_KEY = keyOf(PUB_SEED);
const NEXT_SEED = new Uint8Array(32).fill(94);
const NEXT_KEY = keyOf(NEXT_SEED);
const STRANGER_SEED = new Uint8Array(32).fill(95);
const STRANGER_KEY = keyOf(STRANGER_SEED);
const T0 = "2026-10-27T10:00:00.000Z";
const T1 = "2026-10-27T11:00:00.000Z";
const T2 = "2026-10-27T12:00:00.000Z";

const EMPTY: FeedSource = { publishers: [], requests: [], statements: [] };

async function initFeed(): Promise<TrustFeed> {
  return signTrustFeed(emptyTrustFeed(ROOT_KEY, T0), ROOT_SEED);
}

function source(over: Partial<FeedSource>): FeedSource {
  return { ...EMPTY, ...over };
}

const file = (path: string, raw: unknown): FeedSourceFile => ({ path, raw });
const acme = (keys = [PUB_KEY], github = "acme-dev"): FeedSourceFile =>
  file("publishers/acme.json", { publisherId: "acme", keys, github });
const revokeReq = (name = "revoke-1"): FeedSourceFile =>
  file(`requests/${name}.json`, {
    kind: "key.revoke",
    publisherId: "acme",
    keyFingerprint: publisherKeyFingerprint(PUB_KEY),
    reason: "leaked",
  });
const takedownReq = (versions: "*" | string[], name = "takedown-1"): FeedSourceFile =>
  file(`requests/${name}.json`, {
    kind: "extension.takedown",
    extensionId: "acme/tool",
    publisherId: "acme",
    versions,
    reason: "malware",
  });

async function build(prev: TrustFeed, src: FeedSource, at = T1): Promise<TrustFeed> {
  const { feed } = await buildTrustFeed(prev, src, ROOT_SEED, at);
  if (feed === undefined) throw new Error("expected a new feed");
  return feed;
}

const statementsOf = (feed: TrustFeed): TrustStatement[] =>
  readTrustFeedStatements(feed).statements as TrustStatement[];

async function rotate(
  fromSeed: Uint8Array,
  toKey: string,
  publisherId = "acme",
): Promise<TrustStatement> {
  return signTrustStatement(
    {
      kind: "key.rotate",
      publisherId,
      fromKey: keyOf(fromSeed),
      toKey,
      issuedAt: T0,
      signerKey: keyOf(fromSeed),
    },
    fromSeed,
  );
}

describe("planTrustFeed / buildTrustFeed", () => {
  test("an empty source over the init feed is unchanged and signs nothing", async () => {
    const prev = await initFeed();
    expect(planTrustFeed(prev, EMPTY).status).toBe("unchanged");
    expect((await buildTrustFeed(prev, EMPTY, ROOT_SEED, T1)).feed).toBeUndefined();
  });

  test("a revoke request is signed once, as nimbus, and a re-run or renamed copy adds nothing", async () => {
    const prev = await initFeed();
    const next = await build(prev, source({ requests: [revokeReq()] }));
    expect(next.sequence).toBe(2);
    expect(next.generatedAt).toBe(T1);
    const [s] = statementsOf(next);
    expect(s?.kind).toBe("key.revoke");
    expect(verifyTrustStatement(s as TrustStatement, { nimbusRootKey: ROOT_KEY })).toBe("nimbus");
    const again = planTrustFeed(next, source({ requests: [revokeReq(), revokeReq("renamed")] }));
    expect(again.status).toBe("unchanged");
    // Deleting the request file afterwards keeps the block (R1).
    const later = await build(next, source({ publishers: [acme()] }), T2);
    expect(statementsOf(later).filter((x) => x.kind === "key.revoke")).toHaveLength(1);
  });

  test("two copies of one request in a run sign one statement", async () => {
    const next = await build(
      await initFeed(),
      source({ requests: [revokeReq("a"), revokeReq("b")] }),
    );
    expect(statementsOf(next)).toHaveLength(1);
  });

  test("a takedown already carried under a WIDER version set is not re-signed; a wider one is", async () => {
    const all = await build(await initFeed(), source({ requests: [takedownReq("*")] }));
    expect(
      planTrustFeed(all, source({ requests: [takedownReq(["1.0.0"], "narrow")] })).status,
    ).toBe("unchanged");
    const narrow = await build(await initFeed(), source({ requests: [takedownReq(["1.0.0"])] }));
    const wider = planTrustFeed(narrow, source({ requests: [takedownReq("*", "wide")] }));
    expect(wider.blocks).toHaveLength(1);
  });

  test("requests the format or the feed cannot sign are skipped with their path and reason", async () => {
    const prev = await initFeed();
    const plan = planTrustFeed(
      prev,
      source({
        requests: [
          file("requests/no-publisher.json", {
            kind: "extension.takedown",
            extensionId: "acme/tool",
            versions: "*",
            reason: "x",
          }),
          file("requests/own-root.json", {
            kind: "key.revoke",
            publisherId: "nimbus",
            keyFingerprint: publisherKeyFingerprint(ROOT_KEY),
            reason: "x",
          }),
          file("requests/long.json", {
            kind: "key.revoke",
            publisherId: "acme",
            keyFingerprint: publisherKeyFingerprint(PUB_KEY),
            reason: "x".repeat(501),
          }),
          takedownReq(
            Array.from({ length: 101 }, (_, i) => `1.0.${String(i)}`),
            "many",
          ),
          takedownReq([], "none"),
          takedownReq(["latest"], "not-semver"),
          file("requests/Bad Name.json", {}),
          file("requests/extra.json", { kind: "key.revoke", extra: 1 }),
        ],
      }),
    );
    expect(plan.status).toBe("unchanged");
    expect(plan.skipped.map((s) => s.path).sort()).toEqual(
      [
        "requests/Bad Name.json",
        "requests/extra.json",
        "requests/long.json",
        "requests/many.json",
        "requests/no-publisher.json",
        "requests/none.json",
        "requests/not-semver.json",
        "requests/own-root.json",
      ].sort(),
    );
    expect(plan.skipped.find((s) => s.path === "requests/no-publisher.json")?.reason).toContain(
      "must name its publisher",
    );
    expect(plan.skipped.find((s) => s.path === "requests/own-root.json")?.reason).toContain(
      "own root key",
    );
  });

  test("a publisher file adds a verified entry; the same file keeps its exact statement", async () => {
    const prev = await initFeed();
    const first = await build(prev, source({ publishers: [acme([NEXT_KEY, PUB_KEY])] }));
    const [v] = statementsOf(first);
    expect(v).toMatchObject({ kind: "publisher.verified", github: "acme-dev", verifiedAt: T1 });
    expect((v as { keys: readonly string[] }).keys).toEqual([NEXT_KEY, PUB_KEY].sort());
    // Same content in another key order: unchanged, nothing re-signed.
    expect(planTrustFeed(first, source({ publishers: [acme([PUB_KEY, NEXT_KEY])] })).status).toBe(
      "unchanged",
    );
    // Another change elsewhere keeps the verified statement byte for byte.
    const second = await build(
      first,
      source({ publishers: [acme([PUB_KEY, NEXT_KEY])], requests: [takedownReq("*")] }),
      T2,
    );
    const kept = statementsOf(second).find((s) => s.kind === "publisher.verified");
    expect(trustStatementId(kept as TrustStatement)).toBe(trustStatementId(v as TrustStatement));
  });

  test("changing a key or the handle re-signs; removing the file drops the entry and keeps every block", async () => {
    const one = await build(
      await initFeed(),
      source({ publishers: [acme()], requests: [takedownReq("*")] }),
    );
    const key = planTrustFeed(one, source({ publishers: [acme([NEXT_KEY])] }));
    expect(key.verified).toEqual([
      { publisherId: "acme", keys: [NEXT_KEY], github: "acme-dev", change: "changed" },
    ]);
    const handle = planTrustFeed(one, source({ publishers: [acme([PUB_KEY], "acme-two")] }));
    expect(handle.verified[0]?.change).toBe("changed");
    const removed = await build(one, EMPTY, T2);
    expect(statementsOf(removed).map((s) => s.kind)).toEqual(["extension.takedown"]);
    expect(planTrustFeed(one, EMPTY).unverified).toEqual(["acme"]);
  });

  test("malformed publisher files are skipped with their path", async () => {
    const plan = planTrustFeed(
      await initFeed(),
      source({
        publishers: [
          file("publishers/other.json", { publisherId: "acme", keys: [PUB_KEY], github: "a" }),
          file("publishers/acme.json", { publisherId: "acme", keys: [PUB_KEY], github: "a", x: 1 }),
          file("publishers/b.json", {
            publisherId: "b",
            keys: Array.from({ length: 11 }, (_, i) => keyOf(new Uint8Array(32).fill(i + 1))),
            github: "b",
          }),
          file("publishers/c.json", { publisherId: "c", keys: [PUB_KEY], github: "-bad-" }),
        ],
      }),
    );
    expect(plan.status).toBe("unchanged");
    expect(plan.skipped.map((s) => s.path).sort()).toEqual([
      "publishers/acme.json",
      "publishers/b.json",
      "publishers/c.json",
      "publishers/other.json",
    ]);
  });

  test("a verified publisher's own rotation is admitted; a stranger's rotate-to-victim + revoke is refused", async () => {
    const prev = await initFeed();
    const ok = await rotate(PUB_SEED, NEXT_KEY);
    const plan = planTrustFeed(
      prev,
      source({ publishers: [acme()], statements: [file("statements/ok.json", ok)] }),
    );
    expect(plan.admitted.map(trustStatementId)).toEqual([trustStatementId(ok)]);
    // The R2 attack: a stranger's key S claims publisher "victim", rotates S -> the victim's key and
    // revokes S. "victim" is not verified, so neither reaches the feed.
    const toVictim = await rotate(STRANGER_SEED, PUB_KEY, "victim");
    const revokeS = await signTrustStatement(
      {
        kind: "key.revoke",
        publisherId: "victim",
        keyFingerprint: publisherKeyFingerprint(STRANGER_KEY),
        reason: "x",
        issuedAt: T0,
        signerKey: STRANGER_KEY,
      },
      STRANGER_SEED,
    );
    const attack = planTrustFeed(
      prev,
      source({
        publishers: [acme()],
        statements: [file("statements/a.json", toVictim), file("statements/b.json", revokeS)],
      }),
    );
    expect(attack.admitted).toEqual([]);
    expect(attack.skipped.map((s) => s.path).sort()).toEqual([
      "statements/a.json",
      "statements/b.json",
    ]);
    expect(attack.skipped[0]?.reason).toContain("not verified in the trust feed");
    // A key outside the verified keys' closure, under a verified publisher, is refused too.
    const outside = await rotate(STRANGER_SEED, NEXT_KEY);
    const out = planTrustFeed(
      prev,
      source({ publishers: [acme()], statements: [file("statements/o.json", outside)] }),
    );
    expect(out.admitted).toEqual([]);
    expect(out.skipped[0]?.path).toBe("statements/o.json");
  });

  test("an unparsable statement file is skipped with its path", async () => {
    const plan = planTrustFeed(
      await initFeed(),
      source({ statements: [file("statements/x.json", { kind: "key.rotate" })] }),
    );
    expect(plan.skipped).toEqual([
      { path: "statements/x.json", reason: expect.stringContaining("not a valid statement") },
    ]);
  });

  test("a prev carrying unknown-kind, unparsable and extra blocks keeps them byte for byte", async () => {
    const block = await signFeedRequest(
      { kind: "key.revoke", publisherId: "zeta", keyFingerprint: "b".repeat(32), reason: "r" },
      ROOT_KEY,
      ROOT_SEED,
      T0,
    );
    const future = { kind: "publisher.suspended", publisherId: "zeta", note: "a later kind" };
    const broken = { kind: "key.revoke", publisherId: "zeta" };
    const prev = await signTrustFeed(
      { ...emptyTrustFeed(ROOT_KEY, T0), statements: [block, future, broken] },
      ROOT_SEED,
    );
    const next = await build(prev, source({ requests: [revokeReq()] }));
    const raw = next.statements as unknown[];
    expect(raw.slice(0, 3)).toEqual([block, future, broken]);
    expect(raw).toHaveLength(4);
  });

  test("the built feed passes what a client runs first", async () => {
    const next = await build(
      await initFeed(),
      source({ publishers: [acme()], requests: [revokeReq()] }),
    );
    const reparsed = parseTrustFeed(new TextEncoder().encode(JSON.stringify(next)));
    expect(readTrustFeedStatements(reparsed).dropped).toBe(0);
    await verifyTrustFeedPinned(reparsed, ROOT_KEY);
  });

  test("within one run, a request covers only the same kind and subject", async () => {
    const plan = planTrustFeed(
      await initFeed(),
      source({
        requests: [
          revokeReq("a-revoke"),
          takedownReq("*", "b-all"),
          takedownReq(["1.0.0"], "c-narrow"),
          file("requests/d-other.json", {
            kind: "extension.takedown",
            extensionId: "acme/other",
            publisherId: "acme",
            versions: "*",
            reason: "x",
          }),
        ],
      }),
    );
    // The narrow takedown is covered by the wider one before it; the other id and the revoke are not.
    expect(plan.blocks.map((b) => b.path)).toEqual([
      "requests/a-revoke.json",
      "requests/b-all.json",
      "requests/d-other.json",
    ]);
    const widening = planTrustFeed(
      await initFeed(),
      source({ requests: [takedownReq(["1.0.0"], "a"), takedownReq("*", "b")] }),
    );
    expect(widening.blocks).toHaveLength(2);
  });

  test("files outside their directory or not .json are skipped", async () => {
    const plan = planTrustFeed(
      await initFeed(),
      source({
        requests: [file("requests/x.txt", {}), file("elsewhere/revoke.json", {})],
      }),
    );
    expect(plan.skipped.map((s) => s.path)).toEqual(["elsewhere/revoke.json", "requests/x.txt"]);
  });

  test("a prev whose statements are not a list carries nothing; a verified entry by another key is dropped", async () => {
    const notList = await signTrustFeed(
      { ...emptyTrustFeed(ROOT_KEY, T0), statements: "x" },
      ROOT_SEED,
    );
    expect(statementsOf(await build(notList, source({ requests: [revokeReq()] })))).toHaveLength(1);
    const forged = await signTrustStatement(
      {
        kind: "publisher.verified",
        publisherId: "acme",
        keys: [STRANGER_KEY],
        github: "evil",
        verifiedAt: T0,
        issuedAt: T0,
        signerKey: keyOf(OTHER_SEED),
      },
      OTHER_SEED,
    );
    const prev = await signTrustFeed(
      { ...emptyTrustFeed(ROOT_KEY, T0), statements: [forged] },
      ROOT_SEED,
    );
    // Not Nimbus-signed, so it is not a current entry: the file makes it "added", and it is replaced.
    const plan = planTrustFeed(prev, source({ publishers: [acme()] }));
    expect(plan.verified[0]?.change).toBe("added");
    const next = await build(prev, source({ publishers: [acme()] }));
    expect(statementsOf(next).map((s) => (s as { github?: string }).github)).toEqual(["acme-dev"]);
  });

  test("a feed past the statement cap is refused", async () => {
    const filler = Array.from({ length: 10_000 }, (_, i) => ({ kind: "later.kind", n: i }));
    const prev = await signTrustFeed(
      { ...emptyTrustFeed(ROOT_KEY, T0), statements: filler },
      ROOT_SEED,
    );
    await expect(
      buildTrustFeed(prev, source({ requests: [revokeReq()] }), ROOT_SEED, T1),
    ).rejects.toMatchObject({ code: "ERR_TRUST_FEED_INVALID" });
  });

  test("a seed that is not the feed root is refused", async () => {
    await expect(
      buildTrustFeed(await initFeed(), source({ requests: [revokeReq()] }), OTHER_SEED, T1),
    ).rejects.toMatchObject({ code: "ERR_TRUST_FEED_ROOT_KEY_CHANGED" });
  });
});

describe("alreadyCarried with role nimbus", () => {
  test("only a statement signed by the document's own root counts", async () => {
    const req = {
      kind: "key.revoke" as const,
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(PUB_KEY),
      reason: "x",
    };
    const byOther = await signTrustStatement(
      { ...req, issuedAt: T0, signerKey: keyOf(OTHER_SEED) },
      OTHER_SEED,
    );
    const doc = { extensions: {}, rootKey: ROOT_KEY };
    expect(alreadyCarried({ ...doc, statements: [byOther] }, req, "nimbus")).toBe(false);
    const byRoot = await signFeedRequest(req, ROOT_KEY, ROOT_SEED, T0);
    expect(alreadyCarried({ ...doc, statements: [byRoot] }, req, "nimbus")).toBe(true);
    // The same root statement does not count for a registry-role check of a different root.
    expect(
      alreadyCarried({ ...doc, rootKey: keyOf(OTHER_SEED), statements: [byRoot] }, req, "nimbus"),
    ).toBe(false);
  });

  test("signFeedRequest refuses a seed that is not the feed root", async () => {
    await expect(
      signFeedRequest(
        { kind: "key.revoke", publisherId: "acme", keyFingerprint: "c".repeat(32), reason: "x" },
        ROOT_KEY,
        OTHER_SEED,
        T0,
      ),
    ).rejects.toMatchObject({ code: "ERR_TRUST_STATEMENT_INVALID" });
  });
});

describe("parseFeedConfig / parsePublisherFile", () => {
  test("the config is exactly { format: 1 }", () => {
    expect(parseFeedConfig({ format: 1 })).toEqual({ format: 1 });
    for (const bad of [null, [], { format: 2 }, { format: 1, extra: true }, {}]) {
      expect(() => parseFeedConfig(bad)).toThrow("must be exactly");
    }
  });

  test("a publisher file returns its keys sorted", () => {
    const e = parsePublisherFile("publishers/acme.json", {
      publisherId: "acme",
      keys: [PUB_KEY, NEXT_KEY],
      github: "acme-dev",
    });
    expect(e.keys).toEqual([PUB_KEY, NEXT_KEY].sort());
    expect(() => parsePublisherFile("publishers/acme.json", "x")).toThrow("must be an object");
    expect(() =>
      parsePublisherFile("publishers/sub/acme.json", {
        publisherId: "acme",
        keys: [PUB_KEY],
        github: "a",
      }),
    ).toThrow("must be named");
  });
});
