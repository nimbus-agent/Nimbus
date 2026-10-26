import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { codeUnitCompare } from "./code-unit-compare.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import type { RegistryExtensionEntry } from "./index-format.ts";
import {
  admitPublisherStatements,
  currentPublisherKeys,
  isPublisherKeyRevoked,
  MAX_REGISTRY_STATEMENTS,
  MAX_ROTATIONS_PER_PUBLISHER,
  MAX_STATEMENTS_PER_PUBLISHER,
  publisherAfterPublish,
  publisherKeyStanding,
  type StatementIndex,
} from "./publisher-statements.ts";
import { signTrustStatement, type TrustStatement, trustStatementId } from "./trust-statement.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

interface Key {
  seed: Uint8Array;
  key: string;
  fp: string;
}

function keyOf(n: number): Key {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i) % 256);
  const key = b64(nacl.sign.keyPair.fromSeed(seed).publicKey);
  return { seed, key, fp: publisherKeyFingerprint(key) };
}

const K = keyOf(1);
const X = keyOf(2);
const Y = keyOf(3);
const Z = keyOf(4);
const STRANGER = keyOf(5);
const OTHER_PUB = keyOf(6);

const ISSUED = "2026-10-26T12:00:00Z";

function entry(publisherId: string, key: string): RegistryExtensionEntry {
  return {
    publisher: { id: publisherId, key },
    versions: {
      "1.0.0": {
        channel: "stable",
        name: "x",
        manifest: "m",
        manifestSha256: "0".repeat(64),
        package: "p",
        packageSha256: "0".repeat(64),
        packageSizeBytes: 1,
        entryHash: "0".repeat(64),
        publishedAt: ISSUED,
      },
    },
  };
}

function index(
  extensions: Record<string, RegistryExtensionEntry>,
  statements?: unknown[],
): StatementIndex {
  return statements === undefined ? { extensions } : { extensions, statements };
}

const ACME = { "acme/tool": entry("acme", K.key) };

function rotate(
  from: Key,
  to: Key,
  issuedAt = ISSUED,
  publisherId = "acme",
): Promise<TrustStatement> {
  return signTrustStatement(
    {
      kind: "key.rotate",
      issuedAt,
      signerKey: from.key,
      publisherId,
      fromKey: from.key,
      toKey: to.key,
    },
    from.seed,
  );
}

function revoke(k: Key, reason = "leaked", publisherId = "acme"): Promise<TrustStatement> {
  return signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: k.key,
      publisherId,
      keyFingerprint: k.fp,
      reason,
    },
    k.seed,
  );
}

const reasons = (a: ReturnType<typeof admitPublisherStatements>): string[] =>
  a.skipped.map((s) => s.reason);

describe("admitPublisherStatements — who may plant a statement", () => {
  test("a rotation from the bound key is admitted and appended to statements", async () => {
    const r = await rotate(K, X);
    const a = admitPublisherStatements(index(ACME), [r]);
    expect(a.skipped).toEqual([]);
    expect(a.admitted.map(trustStatementId)).toEqual([trustStatementId(r)]);
    expect(a.index.statements).toEqual([r]);
  });

  test("a stranger's key cannot plant a rotation under someone else's publisher id", async () => {
    const a = admitPublisherStatements(index(ACME), [await rotate(STRANGER, Z)]);
    expect(a.admitted).toEqual([]);
    expect(reasons(a)[0]).toContain("not bound to publisher acme");
  });

  test("a publisher id with no extension in the index is refused", async () => {
    const a = admitPublisherStatements(index(ACME), [await rotate(OTHER_PUB, Z, ISSUED, "other")]);
    expect(reasons(a)[0]).toContain("no extension in this index");
  });

  test("root-only kinds, bad signatures and non-statements are skipped, never fatal", async () => {
    const r = await rotate(K, X);
    const forged = { ...r, toKey: Y.key };
    const takedown = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: ISSUED,
        signerKey: K.key,
        extensionId: "acme/tool",
        publisherId: "acme",
        versions: "*",
        reason: "x",
      },
      K.seed,
    );
    const a = admitPublisherStatements(index(ACME), [forged, takedown, 42, { kind: "nope" }]);
    expect(a.admitted).toEqual([]);
    expect(a.skipped).toHaveLength(4);
    expect(reasons(a).join("\n")).toContain("not signed by the key it concerns");
    expect(reasons(a).join("\n")).toContain("extension.takedown");
  });

  test("a revocation by the revoked key is admitted; a second one of the same key is redundant", async () => {
    const first = await revoke(K, "one");
    const second = await revoke(K, "two");
    const a = admitPublisherStatements(index(ACME), [first, second]);
    expect(a.admitted).toHaveLength(1);
    expect(reasons(a)).toEqual([`redundant: key ${K.fp} is already revoked`]);
  });
});

describe("admitPublisherStatements — order independence", () => {
  test("a chain K→X→Y submitted as two files is admitted in either order, with nothing skipped", async () => {
    const kx = await rotate(K, X);
    const xy = await rotate(X, Y);
    for (const batch of [
      [kx, xy],
      [xy, kx],
    ]) {
      const a = admitPublisherStatements(index(ACME), batch);
      expect(a.skipped).toEqual([]);
      expect(a.admitted).toHaveLength(2);
    }
  });

  test("rotate K→X plus revoke K in one batch has ONE outcome whatever the ids (R3)", async () => {
    // Several issuedAt values give several id orders between the two statements.
    const outcomes = new Set<string>();
    for (const issuedAt of [
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-03-01T00:00:00Z",
    ]) {
      const kx = await rotate(K, X, issuedAt);
      const rk = await revoke(K);
      for (const batch of [
        [kx, rk],
        [rk, kx],
      ]) {
        const a = admitPublisherStatements(index(ACME), batch);
        outcomes.add(`${a.admitted.map((s) => s.kind).join(",")}|${reasons(a).join(",")}`);
      }
    }
    expect([...outcomes]).toEqual([`key.revoke|from revoked key ${K.fp}`]);
  });

  test("a fork inside one batch skips both rotations", async () => {
    const a = admitPublisherStatements(index(ACME), [await rotate(K, X), await rotate(K, Y)]);
    expect(a.admitted).toEqual([]);
    expect(reasons(a)).toHaveLength(2);
    for (const r of reasons(a)) expect(r).toContain("fork");
  });

  test("against an already-admitted rotation, a different rotation from the same key is a fork", async () => {
    const kx = await rotate(K, X);
    const a = admitPublisherStatements(index(ACME, [kx]), [await rotate(K, Y)]);
    expect(a.admitted).toEqual([]);
    expect(reasons(a)[0]).toContain("fork");
  });

  test("a statement already in the index is kept once and is not new", async () => {
    const kx = await rotate(K, X);
    const a = admitPublisherStatements(index(ACME, [kx]), [kx, kx]);
    expect(a.admitted).toEqual([]);
    expect(a.skipped).toEqual([]);
    expect(a.index.statements).toEqual([kx]);
  });

  test("nothing admitted returns the index itself: no empty statements field appears", async () => {
    const idx = index(ACME);
    const a = admitPublisherStatements(idx, [await rotate(STRANGER, Z)]);
    expect(a.index).toBe(idx);
    expect("statements" in a.index).toBe(false);
  });

  test("existing raw statements (even unknown kinds) are carried first, verbatim", async () => {
    const raw = { kind: "future.kind", x: 1 };
    const kx = await rotate(K, X);
    const a = admitPublisherStatements(index(ACME, [raw]), [kx]);
    expect(a.index.statements).toEqual([raw, kx]);
  });
  test("existing rotations stored out of chain order still reach the current key", async () => {
    const idx = index(ACME, [await rotate(X, Y), await rotate(K, X)]);
    const a = admitPublisherStatements(idx, [await rotate(Y, Z)]);
    expect(a.skipped).toEqual([]);
    expect(a.admitted).toHaveLength(1);
  });
});

describe("admitPublisherStatements — caps", () => {
  test("a publisher's rotations stop at the per-publisher cap; another publisher still gets in", async () => {
    const keys = Array.from({ length: MAX_ROTATIONS_PER_PUBLISHER + 2 }, (_, i) => keyOf(100 + i));
    const exts = {
      "acme/tool": entry("acme", keys[0]?.key ?? ""),
      "beta/tool": entry("beta", OTHER_PUB.key),
    };
    const chain: TrustStatement[] = [];
    for (let i = 0; i + 1 < keys.length; i++) {
      chain.push(await rotate(keys[i] as Key, keys[i + 1] as Key));
    }
    const beta = await rotate(OTHER_PUB, Z, ISSUED, "beta");
    const a = admitPublisherStatements(index(exts), [...chain, beta]);
    expect(a.admitted.filter((s) => s.publisherId === "acme")).toHaveLength(
      MAX_ROTATIONS_PER_PUBLISHER,
    );
    expect(a.admitted.filter((s) => s.publisherId === "beta")).toHaveLength(1);
    expect(reasons(a).some((r) => r.includes("rotation cap"))).toBe(true);
  });

  test("the index cap refuses statements past MAX_REGISTRY_STATEMENTS", async () => {
    const full = Array.from({ length: MAX_REGISTRY_STATEMENTS }, (_, i) => ({
      kind: "future.kind",
      i,
    }));
    const a = admitPublisherStatements(index(ACME, full), [await rotate(K, X)]);
    expect(a.admitted).toEqual([]);
    expect(reasons(a)[0]).toContain("statement cap");
  });
});

describe("currentPublisherKeys / isPublisherKeyRevoked / publisherKeyStanding", () => {
  const sorted = (s: Set<string>): string[] => [...s].sort(codeUnitCompare);

  test("no statements: the bound key is current", () => {
    expect(sorted(currentPublisherKeys(index(ACME), "acme"))).toEqual([K.key]);
  });

  test("after one rotation the new key is current, for a sibling still bound to K too", async () => {
    const exts = { "acme/tool": entry("acme", X.key), "acme/other": entry("acme", K.key) };
    const idx = index(exts, [await rotate(K, X)]);
    expect(sorted(currentPublisherKeys(idx, "acme"))).toEqual([X.key]);
    expect(publisherKeyStanding(idx, "acme", X.key)).toEqual({ ok: true });
    const old = publisherKeyStanding(idx, "acme", K.key);
    expect(old).toMatchObject({ ok: false, reason: "superseded", current: [X.key] });
  });

  test("a fork has two current keys and no key is accepted", async () => {
    const idx = index(ACME, [await rotate(K, X), await rotate(K, Y)]);
    expect(currentPublisherKeys(idx, "acme").size).toBe(2);
    expect(publisherKeyStanding(idx, "acme", X.key)).toMatchObject({ ok: false, reason: "fork" });
  });

  test("an unrelated key is refused as unrelated", () => {
    expect(publisherKeyStanding(index(ACME), "acme", Z.key)).toMatchObject({
      ok: false,
      reason: "unrelated",
    });
  });

  test("a revoked key, and (R4) a key rotated from it, are revoked", async () => {
    const idx = index(ACME, [await rotate(K, X), await revoke(K)]);
    expect(isPublisherKeyRevoked(idx, "acme", K.key)).toBe(true);
    expect(isPublisherKeyRevoked(idx, "acme", X.key)).toBe(true);
    expect(isPublisherKeyRevoked(idx, "acme", Y.key)).toBe(false);
    expect(publisherKeyStanding(idx, "acme", X.key)).toMatchObject({
      ok: false,
      reason: "revoked",
    });
  });

  test("a loop leaves no current key (fork); all bound keys revoked leaves the publisher unrelated", async () => {
    const looped = index(ACME, [await rotate(K, X), await rotate(X, K)]);
    expect(publisherKeyStanding(looped, "acme", Z.key)).toMatchObject({
      ok: false,
      reason: "fork",
    });
    const dead = index(ACME, [await revoke(K)]);
    expect(publisherKeyStanding(dead, "acme", Z.key)).toMatchObject({
      ok: false,
      reason: "unrelated",
      current: [],
    });
  });

  test("a new publisher is accepted unless its key is revoked in the index", async () => {
    expect(publisherKeyStanding(index(ACME), "fresh", Z.key)).toEqual({ ok: true });
    const idx = index(ACME, [await revoke(Z, "leaked", "fresh")]);
    expect(publisherKeyStanding(idx, "fresh", Z.key)).toMatchObject({
      ok: false,
      reason: "revoked",
    });
  });

  test("statements signed by someone else (forged) are ignored by the readers", async () => {
    const forged = { ...(await rotate(K, X)), toKey: Y.key };
    const idx = index(ACME, [forged]);
    expect(sorted(currentPublisherKeys(idx, "acme"))).toEqual([K.key]);
  });
});

describe("final review fixes", () => {
  test("I2: revoking the successor never makes the superseded key current again", async () => {
    const exts = { "acme/tool": entry("acme", X.key), "acme/other": entry("acme", K.key) };
    const idx = index(exts, [await rotate(K, X), await revoke(X)]);
    expect(currentPublisherKeys(idx, "acme").size).toBe(0);
    expect(publisherKeyStanding(idx, "acme", K.key)).toMatchObject({
      ok: false,
      reason: "superseded",
    });
  });

  test("I2: an intermediate key whose successor is revoked is not current either", async () => {
    const idx = index(ACME, [await rotate(K, X), await rotate(X, Y), await revoke(Y)]);
    expect(currentPublisherKeys(idx, "acme").size).toBe(0);
    expect(publisherKeyStanding(idx, "acme", X.key)).toMatchObject({ ok: false });
  });

  test("I4: refused (forked) rotations do not let their targets' revocations in", async () => {
    const targets = Array.from({ length: 6 }, (_, i) => keyOf(300 + i));
    const batch: TrustStatement[] = [];
    for (const t of targets) {
      batch.push(await rotate(K, t), await revoke(t));
    }
    const a = admitPublisherStatements(index(ACME), batch);
    expect(a.admitted).toEqual([]);
  });

  test("I4: a revocation of a key an admitted rotation reaches IS admitted, in either order", async () => {
    for (const order of [0, 1]) {
      const kx = await rotate(K, X);
      const rx = await revoke(X);
      const a = admitPublisherStatements(index(ACME), order === 0 ? [kx, rx] : [rx, kx]);
      expect(a.admitted.map((s) => s.kind).sort(codeUnitCompare)).toEqual([
        "key.revoke",
        "key.rotate",
      ]);
    }
  });

  test("I4: a publisher's total statements are capped", async () => {
    const keys = Array.from({ length: MAX_STATEMENTS_PER_PUBLISHER + 5 }, (_, i) => keyOf(400 + i));
    const exts = Object.fromEntries(
      keys.map((k, i) => [`acme/t${String(i)}`, entry("acme", k.key)]),
    );
    const batch = await Promise.all(keys.map((k) => revoke(k)));
    const a = admitPublisherStatements(index(exts), batch);
    expect(a.admitted).toHaveLength(MAX_STATEMENTS_PER_PUBLISHER);
    expect(reasons(a).some((r) => r.includes("statement cap"))).toBe(true);
  });

  test("M2: a rotation from a key tainted by a revoked ancestor is refused", async () => {
    // K stays bound and live through a second path is impossible here, so taint X directly:
    // R -> X is admitted history, R is revoked, K -> X as well; X -> Y must be refused.
    const R = keyOf(7);
    const exts = { "acme/tool": entry("acme", K.key), "acme/r": entry("acme", R.key) };
    const idx = index(exts, [await rotate(R, X), await revoke(R)]);
    const a = admitPublisherStatements(idx, [await rotate(X, Y)]);
    expect(a.admitted).toEqual([]);
    expect(reasons(a)[0]).toContain("revoked");
  });

  test("K->X, X->Y and revoke X in one batch: X->Y is refused whatever the ids (R3)", async () => {
    const outcomes = new Set<string>();
    for (const issuedAt of [
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    ]) {
      const batch = [await rotate(K, X, issuedAt), await rotate(X, Y, issuedAt), await revoke(X)];
      const a = admitPublisherStatements(index(ACME), batch);
      outcomes.add(
        a.admitted
          .map((st) =>
            st.kind === "key.rotate" ? `rotate>${st.toKey === X.key ? "X" : "Y"}` : st.kind,
          )
          .sort(codeUnitCompare)
          .join(","),
      );
    }
    expect([...outcomes]).toEqual(["key.revoke,rotate>X"]);
  });

  test("M3: a rotation back to an already-reached key (a loop) is refused", async () => {
    const idx = index(ACME, [await rotate(K, X)]);
    const a = admitPublisherStatements(idx, [await rotate(X, K)]);
    expect(a.admitted).toEqual([]);
    expect(reasons(a)[0]).toContain("already reached");
  });
});

describe("publisherAfterPublish", () => {
  test("keeps the entry's publisher for the same key and moves to the signer on a new key", () => {
    const existing = entry("acme", K.key);
    expect(publisherAfterPublish(existing, { id: "acme", key: K.key })).toBe(existing.publisher);
    expect(publisherAfterPublish(existing, { id: "acme", key: X.key })).toEqual({
      id: "acme",
      key: X.key,
    });
    expect(publisherAfterPublish(undefined, { id: "acme", key: X.key })).toEqual({
      id: "acme",
      key: X.key,
    });
  });
});
