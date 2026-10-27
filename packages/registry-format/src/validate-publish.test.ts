import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOSONAR S1874: the flat manifest signature contract the gateway verifies (I16); see manifest.ts.
import { signManifest } from "@nimbus-dev/sdk"; // NOSONAR S1874
import { create } from "tar";
import { MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES } from "./caps.ts";
import { RegistryError, type RegistryErrorCode } from "./errors.ts";
import { publisherKeyFingerprint } from "./fingerprint.ts";
import type { RegistryExtensionEntry, RegistryIndex } from "./index-format.ts";
import { packExtensionDir } from "./pack.ts";
import { emptyIndex, publicKeyFromSeed, signIndex } from "./sign.ts";
import { signTrustStatement, type TrustStatement } from "./trust-statement.ts";
import {
  effectiveRegistryConfig,
  type PublishCandidate,
  parseRegistryConfig,
  type RegistryConfig,
  validatePublish,
} from "./validate-publish.ts";

const SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(9);
const ROOT_SEED = new Uint8Array(32).fill(3);
const KEY = Buffer.from(publicKeyFromSeed(SEED)).toString("base64");
const OTHER_KEY = Buffer.from(publicKeyFromSeed(OTHER_SEED)).toString("base64");
const ENTRY_SOURCE = "export default 1;\n";
const HEX64 = "a".repeat(64);

const NS: RegistryConfig = { format: 1, requirePublisherNamespace: true };
const NO_NS: RegistryConfig = { format: 1, requirePublisherNamespace: false };

let tmp: string;
let work: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-validate-publish-"));
  work = join(tmp, "work");
  mkdirSync(work);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface ManifestOpts {
  id?: string;
  version?: string;
  publisherId?: string;
  seed?: Uint8Array;
  extra?: Record<string, unknown>;
  omit?: string[];
  unsigned?: boolean;
}

async function signedManifest(o: ManifestOpts = {}): Promise<Uint8Array> {
  const seed = o.seed ?? SEED;
  const key = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  const m: Record<string, unknown> = {
    id: o.id ?? "acme/echo",
    version: o.version ?? "1.0.0",
    name: "Echo",
    entry: "dist/index.js",
    permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
    updateChannel: "stable",
    ...(o.unsigned === true ? {} : { publisher: { id: o.publisherId ?? "acme", key } }),
    ...o.extra,
  };
  for (const k of o.omit ?? []) delete m[k];
  if (o.unsigned !== true) m["signature"] = await signManifest(m, seed); // NOSONAR S1874
  return enc(JSON.stringify(m, null, 2));
}

let dirCount = 0;
/** An extension dir holding `manifestBytes`, the entry and a README; packed with the real packer. */
async function packOf(
  manifestBytes: Uint8Array,
  files: Record<string, string> = {},
): Promise<Uint8Array> {
  dirCount++;
  const dir = join(tmp, `ext${String(dirCount)}`);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), ENTRY_SOURCE);
  writeFileSync(join(dir, "README.md"), "hi");
  writeFileSync(join(dir, "nimbus.extension.json"), manifestBytes);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const tgz = join(tmp, `p${String(dirCount)}.tgz`);
  await packExtensionDir(dir, tgz);
  return new Uint8Array(readFileSync(tgz));
}

/** A tgz holding exactly `rels` from a fresh dir — bypasses the package file set on purpose. */
async function rawTgz(manifestBytes: Uint8Array, rels: string[]): Promise<Uint8Array> {
  dirCount++;
  const dir = join(tmp, `raw${String(dirCount)}`);
  for (const rel of rels) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), rel === "nimbus.extension.json" ? manifestBytes : ENTRY_SOURCE);
  }
  const tgz = join(tmp, `r${String(dirCount)}.tgz`);
  await create({ gzip: true, file: tgz, cwd: dir, portable: true }, rels);
  return new Uint8Array(readFileSync(tgz));
}

/** An uncompressed ustar archive built byte by byte, so it can hold names a filesystem cannot. */
function ustar(entries: { name: string; body: Uint8Array | string }[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body);
    const h = Buffer.alloc(512);
    const put = (off: number, value: string): void => {
      h.write(value, off, "ascii");
    };
    put(0, e.name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    h.fill(" ", 148, 156);
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    let sum = 0;
    for (const b of h) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(parts));
}

function request(o: Record<string, unknown> = {}): Uint8Array {
  return enc(
    JSON.stringify({
      id: "acme/echo",
      version: "1.0.0",
      channel: "stable",
      publisherFingerprint: publisherKeyFingerprint(KEY),
      ...o,
    }),
  );
}

async function candidate(
  o: {
    manifest?: Uint8Array;
    pkg?: Uint8Array;
    req?: Uint8Array;
    dirId?: string;
    dirVersion?: string;
  } = {},
): Promise<PublishCandidate> {
  const manifestBytes = o.manifest ?? (await signedManifest());
  return {
    dirId: o.dirId ?? "acme/echo",
    dirVersion: o.dirVersion ?? "1.0.0",
    manifestBytes,
    packageBytes: o.pkg ?? (await packOf(manifestBytes)),
    publishRequestBytes: o.req ?? request(),
  };
}

function entryFor(
  id: string,
  publisherId: string,
  key: string,
  versions: string[],
): RegistryExtensionEntry {
  const v: Record<string, RegistryExtensionEntry["versions"][string]> = {};
  for (const version of versions) {
    v[version] = {
      channel: "stable",
      name: id,
      manifest: `extensions/${id}/${version}/manifest.json`,
      manifestSha256: HEX64,
      package: `extensions/${id}/${version}/package.tgz`,
      packageSha256: HEX64,
      packageSizeBytes: 10,
      entryHash: HEX64,
      publishedAt: "2026-10-01T00:00:00.000Z",
    };
  }
  return { publisher: { id: publisherId, key }, versions: v };
}

async function indexOf(
  extensions: Record<string, RegistryExtensionEntry> = {},
  statements?: TrustStatement[],
): Promise<RegistryIndex> {
  const rootKey = Buffer.from(publicKeyFromSeed(ROOT_SEED)).toString("base64");
  const base = { ...emptyIndex(rootKey), extensions };
  return signIndex(statements === undefined ? base : { ...base, statements }, ROOT_SEED);
}

const ISSUED = "2026-10-26T12:00:00Z";

function rotateKey(fromSeed: Uint8Array, toKey: string): Promise<TrustStatement> {
  const fromKey = Buffer.from(publicKeyFromSeed(fromSeed)).toString("base64");
  return signTrustStatement(
    {
      kind: "key.rotate",
      issuedAt: ISSUED,
      signerKey: fromKey,
      publisherId: "acme",
      fromKey,
      toKey,
    },
    fromSeed,
  );
}

function revokeKey(seed: Uint8Array, publisherId = "acme"): Promise<TrustStatement> {
  const key = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  return signTrustStatement(
    {
      kind: "key.revoke",
      issuedAt: ISSUED,
      signerKey: key,
      publisherId,
      keyFingerprint: publisherKeyFingerprint(key),
      reason: "leaked",
    },
    seed,
  );
}

async function refusal(p: Promise<unknown>): Promise<RegistryError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RegistryError) return e;
    throw e;
  }
  throw new Error("expected a RegistryError, got success");
}

async function expectRefused(
  p: Promise<unknown>,
  code: RegistryErrorCode,
  fragment: string,
): Promise<void> {
  const e = await refusal(p);
  expect(e.code).toBe(code);
  expect(e.detail).toContain(fragment);
}

describe("parseRegistryConfig", () => {
  test("parses the config", () => {
    expect(parseRegistryConfig(enc('{"format":1,"requirePublisherNamespace":true}'))).toEqual(NS);
  });

  test("an unknown key is refused", () => {
    expect(() =>
      parseRegistryConfig(enc('{"format":1,"requirePublisherNamespace":true,"x":1}')),
    ).toThrow("unknown key: x");
  });

  test("a missing key, a wrong format and a non-boolean rule are refused", () => {
    expect(() => parseRegistryConfig(enc('{"format":1}'))).toThrow("requirePublisherNamespace");
    expect(() => parseRegistryConfig(enc('{"format":2,"requirePublisherNamespace":true}'))).toThrow(
      "format",
    );
    expect(() =>
      parseRegistryConfig(enc('{"format":1,"requirePublisherNamespace":"yes"}')),
    ).toThrow("requirePublisherNamespace");
    expect(() => parseRegistryConfig(enc("[1]"))).toThrow("object");
    expect(() => parseRegistryConfig(enc("{nope"))).toThrow("JSON");
  });

  test("every malformed config is refused with ERR_REGISTRY_CONFIG_INVALID", () => {
    for (const text of [
      "{nope",
      "[1]",
      '{"format":1}',
      '{"format":2,"requirePublisherNamespace":true}',
      '{"format":1,"requirePublisherNamespace":true,"x":1}',
      `{"format":1,"requirePublisherNamespace":true,"pad":"${"p".repeat(5000)}"}`,
    ]) {
      let code: string | undefined;
      try {
        parseRegistryConfig(enc(text));
      } catch (e) {
        code = e instanceof RegistryError ? e.code : "not a RegistryError";
      }
      expect(code).toBe("ERR_REGISTRY_CONFIG_INVALID");
    }
  });
});

describe("effectiveRegistryConfig", () => {
  test("is the stricter of gh-pages' and the default branch's, absent counting as no rule", () => {
    expect(effectiveRegistryConfig(undefined, undefined)).toEqual(NO_NS);
    expect(effectiveRegistryConfig(NO_NS, NO_NS)).toEqual(NO_NS);
    expect(effectiveRegistryConfig(NS, undefined)).toEqual(NS);
    expect(effectiveRegistryConfig(undefined, NS)).toEqual(NS);
    expect(effectiveRegistryConfig(NO_NS, NS)).toEqual(NS);
    expect(effectiveRegistryConfig(NS, NO_NS)).toEqual(NS);
  });
});

describe("validatePublish", () => {
  test("a good candidate yields a fully populated verdict", async () => {
    const c = await candidate();
    const v = await validatePublish(c, await indexOf(), NS, work);
    expect(v).toEqual({
      id: "acme/echo",
      version: "1.0.0",
      channel: "stable",
      name: "Echo",
      publisher: { id: "acme", key: KEY },
      entryHash: sha256(enc(ENTRY_SOURCE)),
      manifestSha256: sha256(c.manifestBytes),
      packageSha256: sha256(c.packageBytes),
      packageSizeBytes: c.packageBytes.byteLength,
      newId: true,
      permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
    });
    // Its scratch space is inside `work` and is cleaned up.
    expect(readdirSync(work)).toEqual([]);
  });

  test("a declared repository rides the verdict; a malformed one is absent, never a refusal", async () => {
    const declared = await signedManifest({ extra: { repository: "acme/echo" } });
    const v = await validatePublish(
      await candidate({ manifest: declared }),
      await indexOf(),
      NS,
      work,
    );
    expect(v.repository).toBe("acme/echo");
    const malformed = await signedManifest({
      extra: { repository: "https://github.com/acme/echo.git" },
    });
    const w = await validatePublish(
      await candidate({ manifest: malformed }),
      await indexOf(),
      NS,
      work,
    );
    expect(w.repository).toBeUndefined();
    expect("repository" in w).toBe(false);
  });

  test("a new version of an indexed id by the same publisher is not a new id", async () => {
    const signed = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["0.9.0"]) });
    const v = await validatePublish(
      await candidate({ req: request({ channel: "beta" }) }),
      signed,
      NS,
      work,
    );
    expect(v.newId).toBe(false);
    expect(v.channel).toBe("beta");
  });

  // Rule 1
  test("a publish request with an unknown key is refused", async () => {
    await expectRefused(
      validatePublish(await candidate({ req: request({ extra: 1 }) }), await indexOf(), NS, work),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "unknown key: extra",
    );
  });

  test("a publish request with an unknown channel is refused", async () => {
    await expectRefused(
      validatePublish(
        await candidate({ req: request({ channel: "nightly" }) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "channel",
    );
  });

  test("a publish request that is not JSON or misses a key is refused", async () => {
    await expectRefused(
      validatePublish(await candidate({ req: enc("{nope") }), await indexOf(), NS, work),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "JSON",
    );
    await expectRefused(
      validatePublish(
        await candidate({ req: enc('{"id":"acme/echo","version":"1.0.0","channel":"stable"}') }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "publisherFingerprint",
    );
  });

  // Rule 2
  test("an oversized manifest is refused before it is parsed", async () => {
    const manifest = enc(" ".repeat(MAX_MANIFEST_BYTES + 1));
    await expectRefused(
      validatePublish(
        await candidate({ manifest, pkg: new Uint8Array(1) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_TOO_LARGE",
      "manifest",
    );
  });

  test("a manifest the manifest rules refuse is refused", async () => {
    const manifest = enc(JSON.stringify({ id: "acme/echo", version: "1.0.0", updateChannel: "x" }));
    await expectRefused(
      validatePublish(
        await candidate({ manifest, pkg: new Uint8Array(1) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_MANIFEST_INVALID",
      "updateChannel",
    );
  });

  test("a non-semver manifest version is refused", async () => {
    const manifest = await signedManifest({ version: "1.0" });
    await expectRefused(
      validatePublish(
        await candidate({ manifest, dirVersion: "1.0", req: request({ version: "1.0" }) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_MANIFEST_INVALID",
      "semver",
    );
  });

  // Rule 3
  test("a manifest id that differs from the directory is refused", async () => {
    await expectRefused(
      validatePublish(await candidate({ dirId: "acme/other" }), await indexOf(), NS, work),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "acme/other",
    );
  });

  test("a publish-request version that differs from the manifest is refused", async () => {
    await expectRefused(
      validatePublish(
        await candidate({ req: request({ version: "2.0.0" }) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "2.0.0",
    );
  });

  // Rule 4
  test("an unsigned manifest is refused", async () => {
    const manifest = await signedManifest({ unsigned: true });
    await expectRefused(
      validatePublish(await candidate({ manifest }), await indexOf(), NS, work),
      "ERR_REGISTRY_SIGNATURE_INVALID",
      "publisher",
    );
  });

  test("a manifest whose signature does not verify with its own key is refused", async () => {
    const good = JSON.parse(new TextDecoder().decode(await signedManifest())) as Record<
      string,
      unknown
    >;
    good["name"] = "Tampered";
    const manifest = enc(JSON.stringify(good));
    await expectRefused(
      validatePublish(await candidate({ manifest }), await indexOf(), NS, work),
      "ERR_REGISTRY_SIGNATURE_INVALID",
      "does not verify",
    );
  });

  // Rule 5
  test("a publish-request fingerprint for another key is refused", async () => {
    await expectRefused(
      validatePublish(
        await candidate({
          req: request({ publisherFingerprint: publisherKeyFingerprint(OTHER_KEY) }),
        }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_PUBLISH_REQUEST_INVALID",
      "publisherFingerprint",
    );
  });

  // Rule 6
  test("an id outside the publisher's namespace is refused when the registry requires it", async () => {
    const manifest = await signedManifest({ id: "echo" });
    const c = await candidate({ manifest, dirId: "echo", req: request({ id: "echo" }) });
    await expectRefused(
      validatePublish(c, await indexOf(), NS, work),
      "ERR_REGISTRY_NAMESPACE_REQUIRED",
      "acme/",
    );
    // ...and accepted when it does not.
    expect((await validatePublish(c, await indexOf(), NO_NS, work)).id).toBe("echo");
  });

  // Rule 7
  test("an id that yields no valid service id is refused", async () => {
    const id = `acme/${"x".repeat(70)}`;
    const manifest = await signedManifest({ id });
    await expectRefused(
      validatePublish(
        await candidate({ manifest, dirId: id, req: request({ id }) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_MANIFEST_INVALID",
      "service id",
    );
  });

  // Rule 8
  test("a new id whose service id prefix-collides with an indexed id is refused", async () => {
    // ext_acme_echo (indexed) vs ext_acme_echo_x (candidate): an `_` boundary collision.
    const id = "acme/echo-x";
    const signed = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["1.0.0"]) });
    const manifest = await signedManifest({ id });
    await expectRefused(
      validatePublish(
        await candidate({ manifest, dirId: id, req: request({ id }) }),
        signed,
        NS,
        work,
      ),
      "ERR_REGISTRY_SERVICE_ID_COLLISION",
      "acme/echo",
    );
  });

  test("a new id that only differs by punctuation from an indexed id is refused", async () => {
    const id = "acme/echo.x";
    const signed = await indexOf({
      "acme/echo_x": entryFor("acme/echo_x", "acme", KEY, ["1.0.0"]),
    });
    const manifest = await signedManifest({ id });
    await expectRefused(
      validatePublish(
        await candidate({ manifest, dirId: id, req: request({ id }) }),
        signed,
        NS,
        work,
      ),
      "ERR_REGISTRY_SERVICE_ID_COLLISION",
      "ext_acme_echo_x",
    );
  });

  // Rule 9
  test("validator refuses a second key for an existing publisher id across extensions", async () => {
    // A DIFFERENT, new extension id; the publisher id is already bound to another key elsewhere.
    const signed = await indexOf({
      "acme/other": entryFor("acme/other", "acme", OTHER_KEY, ["1.0.0"]),
    });
    await expectRefused(
      validatePublish(await candidate(), signed, NS, work),
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
      "acme/other",
    );
  });

  test("a new version of an indexed id under another publisher is refused", async () => {
    const signed = await indexOf({ echo: entryFor("echo", "beta-corp", OTHER_KEY, ["0.9.0"]) });
    const manifest = await signedManifest({ id: "echo" });
    await expectRefused(
      validatePublish(
        await candidate({ manifest, dirId: "echo", req: request({ id: "echo" }) }),
        signed,
        NO_NS,
        work,
      ),
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
      "beta-corp",
    );
  });

  describe("rule 9 follows the publisher's key rotations", () => {
    test("a version signed by the key a rotation reaches is accepted", async () => {
      const signed = await indexOf(
        { "acme/echo": entryFor("acme/echo", "acme", OTHER_KEY, ["0.9.0"]) },
        [await rotateKey(OTHER_SEED, KEY)],
      );
      const v = await validatePublish(await candidate(), signed, NS, work);
      expect(v.publisher.key).toBe(KEY);
      expect(v.newId).toBe(false);
    });

    test("a new extension of a publisher whose sibling is still bound to the old key is accepted", async () => {
      const signed = await indexOf(
        { "acme/other": entryFor("acme/other", "acme", OTHER_KEY, ["1.0.0"]) },
        [await rotateKey(OTHER_SEED, KEY)],
      );
      expect((await validatePublish(await candidate(), signed, NS, work)).newId).toBe(true);
    });

    test("after a rotation, a publish still signed by the old key is refused as superseded", async () => {
      const signed = await indexOf(
        {
          "acme/echo": entryFor("acme/echo", "acme", KEY, ["0.9.0"]),
          "acme/other": entryFor("acme/other", "acme", OTHER_KEY, ["1.0.0"]),
        },
        [await rotateKey(OTHER_SEED, KEY)],
      );
      const manifest = await signedManifest({
        seed: OTHER_SEED,
        id: "acme/other",
        version: "1.1.0",
      });
      await expectRefused(
        validatePublish(
          await candidate({
            manifest,
            dirId: "acme/other",
            dirVersion: "1.1.0",
            req: request({
              id: "acme/other",
              version: "1.1.0",
              publisherFingerprint: publisherKeyFingerprint(OTHER_KEY),
            }),
          }),
          signed,
          NS,
          work,
        ),
        "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
        `superseded by ${publisherKeyFingerprint(KEY)}`,
      );
    });

    test("an unrelated key is refused with the --statement hint", async () => {
      const signed = await indexOf({
        "acme/echo": entryFor("acme/echo", "acme", OTHER_KEY, ["0.9.0"]),
      });
      await expectRefused(
        validatePublish(await candidate(), signed, NS, work),
        "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
        "--statement",
      );
    });

    test("a fork refuses both keys", async () => {
      const third = Buffer.from(publicKeyFromSeed(new Uint8Array(32).fill(11))).toString("base64");
      const signed = await indexOf(
        { "acme/echo": entryFor("acme/echo", "acme", OTHER_KEY, ["0.9.0"]) },
        [await rotateKey(OTHER_SEED, KEY), await rotateKey(OTHER_SEED, third)],
      );
      await expectRefused(
        validatePublish(await candidate(), signed, NS, work),
        "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
        "fork",
      );
    });

    test("a revoked key is refused, for a known and for a new publisher", async () => {
      const known = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["0.9.0"]) }, [
        await revokeKey(SEED),
      ]);
      await expectRefused(
        validatePublish(await candidate(), known, NS, work),
        "ERR_REGISTRY_PUBLISHER_KEY_REVOKED",
        publisherKeyFingerprint(KEY),
      );
      const fresh = await indexOf({}, [await revokeKey(SEED)]);
      await expectRefused(
        validatePublish(await candidate(), fresh, NS, work),
        "ERR_REGISTRY_PUBLISHER_KEY_REVOKED",
        publisherKeyFingerprint(KEY),
      );
    });

    test("the first version under a rotated key must be stable, so default installs keep working", async () => {
      const signed = await indexOf(
        { "acme/echo": entryFor("acme/echo", "acme", OTHER_KEY, ["0.9.0"]) },
        [await rotateKey(OTHER_SEED, KEY)],
      );
      await expectRefused(
        validatePublish(await candidate({ req: request({ channel: "beta" }) }), signed, NS, work),
        "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
        "stable",
      );
    });

    test("a new extension under a rotated key may start on beta", async () => {
      const signed = await indexOf(
        { "acme/other": entryFor("acme/other", "acme", OTHER_KEY, ["1.0.0"]) },
        [await rotateKey(OTHER_SEED, KEY)],
      );
      const v = await validatePublish(
        await candidate({ req: request({ channel: "beta" }) }),
        signed,
        NS,
        work,
      );
      expect(v.channel).toBe("beta");
    });

    test("a chain that ends in a revoked key says so, instead of naming an empty current key", async () => {
      const signed = await indexOf(
        { "acme/echo": entryFor("acme/echo", "acme", OTHER_KEY, ["0.9.0"]) },
        [await rotateKey(OTHER_SEED, KEY), await revokeKey(SEED)],
      );
      const third = new Uint8Array(32).fill(11);
      const thirdKey = Buffer.from(publicKeyFromSeed(third)).toString("base64");
      const manifest = await signedManifest({ seed: third });
      const e = await refusal(
        validatePublish(
          await candidate({
            manifest,
            req: request({ publisherFingerprint: publisherKeyFingerprint(thirdKey) }),
          }),
          signed,
          NS,
          work,
        ),
      );
      expect(e.code).toBe("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT");
      expect(e.detail).toContain("has no current key");
      expect(e.detail).not.toContain("superseded by ;");
    });

    test("a brand-new publisher with no statements is accepted", async () => {
      expect((await validatePublish(await candidate(), await indexOf(), NS, work)).newId).toBe(
        true,
      );
    });
  });

  // Rule 10
  test("an already indexed version is refused", async () => {
    const signed = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["1.0.0"]) });
    await expectRefused(
      validatePublish(await candidate(), signed, NS, work),
      "ERR_REGISTRY_VERSION_EXISTS",
      "acme/echo@1.0.0",
    );
  });

  // Rule 11
  test("an oversized package is refused before it is read", async () => {
    await expectRefused(
      validatePublish(
        await candidate({ pkg: new Uint8Array(MAX_PACKAGE_BYTES + 1) }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_TOO_LARGE",
      "package",
    );
  });

  test("a package that is not a tarball is refused", async () => {
    await expectRefused(
      validatePublish(
        await candidate({ pkg: enc("not a tarball at all") }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_EXTRACT_FAILED",
      "package",
    );
  });

  // Rule 12
  test("a package whose manifest differs from the committed manifest is refused", async () => {
    const manifest = await signedManifest();
    const pkg = await packOf(await signedManifest({ extra: { changelog: "other" } }));
    await expectRefused(
      validatePublish(await candidate({ manifest, pkg }), await indexOf(), NS, work),
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      "nimbus.extension.json",
    );
  });

  // Rule 13
  test("an entry outside dist/ is refused", async () => {
    const manifest = await signedManifest({ extra: { entry: "README.md" } });
    await expectRefused(
      validatePublish(await candidate({ manifest }), await indexOf(), NS, work),
      "ERR_REGISTRY_PACKAGE_FILE_SET",
      "extension entry README.md must be a file inside dist/",
    );
  });

  test("a package holding a file outside the package file set is refused", async () => {
    const manifest = await signedManifest();
    const pkg = await rawTgz(manifest, ["dist/index.js", "nimbus.extension.json", "src/server.ts"]);
    await expectRefused(
      validatePublish(await candidate({ manifest, pkg }), await indexOf(), NS, work),
      "ERR_REGISTRY_PACKAGE_FILE_SET",
      "src/server.ts",
    );
  });

  test("an entry named only by `entrypoint` is accepted and that file is hashed", async () => {
    const manifest = await signedManifest({
      omit: ["entry"],
      extra: { entrypoint: "dist/server.js" },
    });
    const pkg = await packOf(manifest, { "dist/server.js": "server" });
    const v = await validatePublish(await candidate({ manifest, pkg }), await indexOf(), NS, work);
    expect(v.entryHash).toBe(sha256(enc("server")));
  });

  test("an `entrypoint` outside dist/ is refused", async () => {
    const manifest = await signedManifest({ omit: ["entry"], extra: { entrypoint: "README.md" } });
    await expectRefused(
      validatePublish(await candidate({ manifest }), await indexOf(), NS, work),
      "ERR_REGISTRY_PACKAGE_FILE_SET",
      "extension entry README.md must be a file inside dist/",
    );
  });

  // Rule 2: only the canonical spelling of an id may be published.
  for (const [id, config] of [
    ["acme//echo", NS],
    ["acme/./echo", NS],
    [" acme/echo", NS],
    ["acme/echo/", NS],
    ["acme\\echo", NO_NS],
    ["./acme/echo", NO_NS],
    ["/acme/echo", NO_NS],
  ] as const) {
    test(`a non-canonical id ${JSON.stringify(id)} is refused`, async () => {
      const manifest = await signedManifest({ id });
      await expectRefused(
        validatePublish(
          await candidate({ manifest, dirId: id, req: request({ id }) }),
          await indexOf(),
          config,
          work,
        ),
        "ERR_REGISTRY_MANIFEST_INVALID",
        "is not canonical",
      );
    });
  }

  for (const id of [
    "acme/ec:ho",
    "acme/ec*ho",
    "acme/_echo",
    "acme/.echo",
    "acme/ec#ho",
    "acme/ec?ho",
    "acme/ec%ho",
    "acme/echo.",
    "acme/echo.lock",
  ]) {
    test(`an id a registry cannot serve, ${JSON.stringify(id)}, is refused`, async () => {
      const manifest = await signedManifest({ id });
      await expectRefused(
        validatePublish(
          await candidate({ manifest, dirId: id, req: request({ id }) }),
          await indexOf(),
          NS,
          work,
        ),
        "ERR_REGISTRY_MANIFEST_INVALID",
        "cannot be published: segment",
      );
    });
  }

  test("an id with '.', '_' and '-' inside a segment is accepted", async () => {
    const id = "acme/echo.v2_beta-1";
    const manifest = await signedManifest({ id });
    const v = await validatePublish(
      await candidate({ manifest, dirId: id, req: request({ id }) }),
      await indexOf(),
      NS,
      work,
    );
    expect(v.id).toBe(id);
  });

  test("a non-canonical twin of an indexed id is refused, not published as a new id", async () => {
    const signed = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["0.9.0"]) });
    const id = "acme//echo";
    const manifest = await signedManifest({ id });
    await expectRefused(
      validatePublish(
        await candidate({ manifest, dirId: id, req: request({ id }) }),
        signed,
        NS,
        work,
      ),
      "ERR_REGISTRY_MANIFEST_INVALID",
      "is not canonical",
    );
  });

  test("a version with surrounding whitespace is refused", async () => {
    const manifest = await signedManifest({ version: " 1.0.0" });
    await expectRefused(
      validatePublish(await candidate({ manifest }), await indexOf(), NS, work),
      "ERR_REGISTRY_MANIFEST_INVALID",
      "surrounding whitespace",
    );
  });

  test("a version with build metadata is refused", async () => {
    const manifest = await signedManifest({ version: "1.0.0+r2" });
    await expectRefused(
      validatePublish(
        await candidate({
          manifest,
          dirVersion: "1.0.0+r2",
          req: request({ version: "1.0.0+r2" }),
        }),
        await indexOf(),
        NS,
        work,
      ),
      "ERR_REGISTRY_MANIFEST_INVALID",
      "build metadata",
    );
  });

  test("a version of equal precedence to an indexed one is refused", async () => {
    const signed = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["1.0.0+r1"]) });
    await expectRefused(
      validatePublish(await candidate(), signed, NS, work),
      "ERR_REGISTRY_VERSION_EXISTS",
      "as 1.0.0+r1",
    );
  });

  test("a package holding the same file twice is refused", async () => {
    const manifest = await signedManifest();
    const pkg = ustar([
      { name: "nimbus.extension.json", body: manifest },
      { name: "dist/index.js", body: ENTRY_SOURCE },
      { name: "dist/index.js", body: ENTRY_SOURCE },
    ]);
    await expectRefused(
      validatePublish(await candidate({ manifest, pkg }), await indexOf(), NS, work),
      "ERR_REGISTRY_PACKAGE_FILE_SET",
      "package holds dist/index.js more than once",
    );
  });

  test("package files that differ only by case are refused", async () => {
    const manifest = await signedManifest();
    const pkg = ustar([
      { name: "nimbus.extension.json", body: manifest },
      { name: "dist/index.js", body: ENTRY_SOURCE },
      { name: "dist/lib.js", body: "a" },
      { name: "dist/LIB.js", body: "b" },
    ]);
    await expectRefused(
      validatePublish(await candidate({ manifest, pkg }), await indexOf(), NS, work),
      "ERR_REGISTRY_PACKAGE_FILE_SET",
      "differ only by case",
    );
  });

  test("the checks run in order: the signature before registry state", async () => {
    // Unsigned AND a duplicate version: the signature refusal comes first.
    const signed = await indexOf({ "acme/echo": entryFor("acme/echo", "acme", KEY, ["1.0.0"]) });
    const manifest = await signedManifest({ unsigned: true });
    const e = await refusal(validatePublish(await candidate({ manifest }), signed, NS, work));
    expect(e.code).toBe("ERR_REGISTRY_SIGNATURE_INVALID");
  });
});
