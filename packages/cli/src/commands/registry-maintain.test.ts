import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packExtensionDir,
  parseTrustStatement,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  signIndex,
  signTrustStatement,
  trustStatementId,
  verifyIndexSignature,
  verifyTrustStatement,
} from "@nimbus-dev/registry-format";
import { encodeBase64, generateEd25519Keypair, signManifest } from "../lib/extension-signing.ts";
import { readIndexFile } from "../lib/registry-index.ts";
import { runRegistryMaintain } from "./registry-maintain.ts";

let tmp: string;
let out: string[];
let err: string[];
const io = {
  stdout: (s: string) => void out.push(s),
  stderr: (s: string) => void err.push(s),
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-maintain-"));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "nimbus-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function makeExtension(
  name: string,
  opts: {
    version?: string;
    signed?: boolean;
    seed?: Uint8Array;
    id?: string;
    suite?: boolean;
  } = {},
): Promise<string> {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  if (opts.suite === true) {
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(
      join(dir, "evals", "basic.eval.json"),
      JSON.stringify({ format: 1, name: "basic", cases: [] }),
    );
  }
  writeFileSync(join(dir, "dist", "index.js"), "export default 1;\n");
  const pair = opts.seed === undefined ? generateEd25519Keypair() : undefined;
  const privkey = opts.seed ?? (pair as { privkey: Uint8Array }).privkey;
  const pubkey = pair?.pubkey ?? publicKeyFromSeed(privkey);
  const manifest: Record<string, unknown> = {
    id: opts.id ?? "com.example.tool",
    name: "Example Tool",
    version: opts.version ?? "1.0.0",
    entry: "dist/index.js",
    permissions: {},
  };
  if (opts.signed !== false) {
    manifest["publisher"] = { id: "example", key: encodeBase64(pubkey) };
    manifest["signature"] = await signManifest(manifest, privkey);
  }
  writeFileSync(join(dir, "nimbus.extension.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

async function init(name = "reg"): Promise<{ dir: string; key: string }> {
  const dir = join(tmp, name);
  const key = join(tmp, `${name}-key`);
  expect(await runRegistryMaintain(["init", dir, "--key", key], io)).toBe(0);
  return { dir, key };
}

describe("registry maintain", () => {
  test("init writes a self-verifying index with sequence 1", async () => {
    const { dir, key } = await init();
    const index = readIndexFile(join(dir, "index.json"));
    expect(index.sequence).toBe(1);
    expect(index.extensions).toEqual({});
    expect(verifyIndexSignature(index)).toBe(true);
    expect(readFileSync(key, "utf8").trim()).toHaveLength(44);
    expect(out.join("")).toContain("fingerprint:");
  });

  test("init refuses to overwrite a key without --force", async () => {
    const { key } = await init();
    err.length = 0;
    const code = await runRegistryMaintain(["init", join(tmp, "reg2"), "--key", key], io);
    expect(code).toBe(2);
    expect(err.join("")).toContain("without --force");
    expect(
      await runRegistryMaintain(["init", join(tmp, "reg2"), "--key", key, "--force"], io),
    ).toBe(0);
  });

  test("a re-sign keeps top-level index fields it does not manage (packs)", async () => {
    const { dir, key } = await init();
    const prev = readIndexFile(join(dir, "index.json"));
    const { signature: _omit, ...unsigned } = prev;
    const packs = { devops: { versions: { "1.0.0": { channel: "stable" } } } };
    const seed = new Uint8Array(Buffer.from(readFileSync(key, "utf8").trim(), "base64"));
    const withPacks = await signIndex({ ...unsigned, packs }, seed);
    writeFileSync(join(dir, "index.json"), JSON.stringify(withPacks, null, 2));
    const ext = await makeExtension("ext");
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(0);
    const index = readIndexFile(join(dir, "index.json"));
    expect(index.sequence).toBe(prev.sequence + 1);
    expect(index.packs).toEqual(packs);
    expect(verifyIndexSignature(index)).toBe(true);
  });

  test("add a dir then the index lists it with correct hashes and sequence 2", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext");
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(0);
    const index = readIndexFile(join(dir, "index.json"));
    expect(index.sequence).toBe(2);
    expect(verifyIndexSignature(index)).toBe(true);
    const entry = index.extensions["com.example.tool"]?.versions["1.0.0"];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.channel).toBe("stable");
    expect(entry.name).toBe("Example Tool");
    const base = join(dir, "extensions", "com.example.tool", "1.0.0");
    const manifestBytes = readFileSync(join(base, "manifest.json"));
    const pkgBytes = readFileSync(join(base, "package.tgz"));
    expect(entry.manifest).toBe("extensions/com.example.tool/1.0.0/manifest.json");
    expect(entry.manifestSha256).toBe(sha(manifestBytes));
    expect(entry.packageSha256).toBe(sha(pkgBytes));
    expect(entry.packageSizeBytes).toBe(pkgBytes.length);
    expect(entry.entryHash).toBe(sha(Buffer.from("export default 1;\n")));
    expect(manifestBytes.toString("utf8")).toBe(
      readFileSync(join(ext, "nimbus.extension.json"), "utf8"),
    );
  });

  test("add of a .tgz file records the hash of the bytes in the registry copy", async () => {
    const first = await init("first");
    const ext = await makeExtension("ext");
    await runRegistryMaintain(["add", first.dir, ext, "--key", first.key], io);
    const src = join(first.dir, "extensions", "com.example.tool", "1.0.0", "package.tgz");
    const second = await init("second");
    expect(await runRegistryMaintain(["add", second.dir, src, "--key", second.key], io)).toBe(0);
    const entry = readIndexFile(join(second.dir, "index.json")).extensions["com.example.tool"]
      ?.versions["1.0.0"];
    const copy = readFileSync(
      join(second.dir, "extensions", "com.example.tool", "1.0.0", "package.tgz"),
    );
    expect(entry?.packageSha256).toBe(sha(copy));
    expect(sha(copy)).toBe(sha(readFileSync(src)));
  });

  test("add of a missing source says it does not exist", async () => {
    const { dir, key } = await init();
    expect(await runRegistryMaintain(["add", dir, join(tmp, "nope.tgz"), "--key", key], io)).toBe(
      2,
    );
    expect(err.join("")).toContain("does not exist");
  });

  test.skipIf(!canSymlink() || process.platform === "win32")(
    "add refuses a symlinked source (POSIX O_NOFOLLOW; Windows follows the maintainer-local path)",
    async () => {
      const { dir, key } = await init();
      const ext = await makeExtension("ext");
      const link = join(tmp, "link");
      symlinkSync(ext, link, "dir");
      expect(await runRegistryMaintain(["add", dir, link, "--key", key], io)).toBe(2);
      expect(err.join("")).toContain("symlink");
    },
  );

  test("add refuses an existing id@version", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext");
    await runRegistryMaintain(["add", dir, ext, "--key", key], io);
    err.length = 0;
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_VERSION_EXISTS");
  });

  test("add refuses a changed publisher key for an existing id", async () => {
    const { dir, key } = await init();
    await runRegistryMaintain(["add", dir, await makeExtension("a"), "--key", key], io);
    const other = await makeExtension("b", { version: "1.1.0" });
    err.length = 0;
    expect(await runRegistryMaintain(["add", dir, other, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT");
  });

  describe("add --statement", () => {
    const OLD_SEED = new Uint8Array(32).fill(41);
    const NEW_SEED = new Uint8Array(32).fill(42);
    const keyOf = (seed: Uint8Array): string => encodeBase64(publicKeyFromSeed(seed));

    async function statementFile(name: string, fromSeed: Uint8Array, toSeed: Uint8Array) {
      const fromKey = keyOf(fromSeed);
      const s = await signTrustStatement(
        {
          kind: "key.rotate",
          issuedAt: "2026-10-26T12:00:00Z",
          signerKey: fromKey,
          publisherId: "example",
          fromKey,
          toKey: keyOf(toSeed),
        },
        fromSeed,
      );
      const path = join(tmp, name);
      writeFileSync(path, JSON.stringify(s));
      return { path, s };
    }

    test("a rotation and the first version under the new key are added together", async () => {
      const { dir, key } = await init();
      await runRegistryMaintain(
        ["add", dir, await makeExtension("a", { seed: OLD_SEED }), "--key", key],
        io,
      );
      const rot = await statementFile("rot.json", OLD_SEED, NEW_SEED);
      const next = await makeExtension("b", { version: "1.1.0", seed: NEW_SEED });
      expect(
        await runRegistryMaintain(["add", dir, next, "--statement", rot.path, "--key", key], io),
      ).toBe(0);
      const index = readIndexFile(join(dir, "index.json"));
      expect(verifyIndexSignature(index)).toBe(true);
      expect(index.statements).toEqual([rot.s]);
      expect(index.extensions["com.example.tool"]?.publisher.key).toBe(keyOf(NEW_SEED));
      expect(out.join("")).toContain(trustStatementId(rot.s).slice(0, 12));
    });

    test("a statement the registry would not admit refuses the whole add", async () => {
      const { dir, key } = await init();
      await runRegistryMaintain(
        ["add", dir, await makeExtension("a", { seed: OLD_SEED }), "--key", key],
        io,
      );
      const stranger = await statementFile("s.json", new Uint8Array(32).fill(43), NEW_SEED);
      const next = await makeExtension("b", { version: "1.1.0", seed: NEW_SEED });
      err.length = 0;
      expect(
        await runRegistryMaintain(
          ["add", dir, next, "--statement", stranger.path, "--key", key],
          io,
        ),
      ).toBe(2);
      expect(err.join("")).toContain("would not admit");
      expect(err.join("")).toContain(publisherKeyFingerprint(keyOf(new Uint8Array(32).fill(43))));
      expect(readIndexFile(join(dir, "index.json")).sequence).toBe(2);
    });

    test("an unreadable statement file is refused", async () => {
      const { dir, key } = await init();
      const ext = await makeExtension("a", { seed: OLD_SEED });
      err.length = 0;
      expect(
        await runRegistryMaintain(
          ["add", dir, ext, "--statement", join(tmp, "nope.json"), "--key", key],
          io,
        ),
      ).toBe(2);
      expect(err.join("")).toContain("nope.json");
    });
  });

  test("add refuses an unsigned extension", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { signed: false });
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_SIGNATURE_INVALID");
  });

  test("add refuses an id a registry cannot serve, the same rule publish applies", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { id: "example/_tool" });
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("ERR_REGISTRY_MANIFEST_INVALID");
    expect(err.join("")).toContain('segment "_tool"');
  });

  test("remove last version drops the id entry", async () => {
    const { dir, key } = await init();
    await runRegistryMaintain(["add", dir, await makeExtension("ext"), "--key", key], io);
    expect(
      await runRegistryMaintain(["remove", dir, "com.example.tool@1.0.0", "--key", key], io),
    ).toBe(0);
    const index = readIndexFile(join(dir, "index.json"));
    expect(index.extensions).toEqual({});
    expect(index.sequence).toBe(3);
    expect(verifyIndexSignature(index)).toBe(true);
  });

  test("maintain on a folder signed by another key refuses", async () => {
    const { dir } = await init();
    const otherKey = join(tmp, "other-key");
    writeFileSync(otherKey, `${encodeBase64(generateEd25519Keypair().privkey)}\n`);
    err.length = 0;
    expect(await runRegistryMaintain(["remove", dir, "x", "--key", otherKey], io)).toBe(2);
    expect(err.join("")).toContain("different key");
  });

  test("an unknown subcommand prints usage and exits 2", async () => {
    expect(await runRegistryMaintain([], io)).toBe(2);
    expect(err.join("")).toContain("Usage:");
  });
});

describe("registry maintain package caps", () => {
  async function craft(name: string, blocks: Buffer[]): Promise<string> {
    const { gzipSync } = await import("node:zlib");
    const file = join(tmp, name);
    writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
    return file;
  }
  async function header(path: string, size: number): Promise<Buffer> {
    const { Header } = await import("tar");
    const buf = Buffer.alloc(512);
    new Header({ path, type: "File", size, mode: 0o644 }).encode(buf, 0);
    return buf;
  }
  function rootListing(dir: string): string[] {
    return readdirSync(join(dir, "extensions"));
  }

  test("refuses an archive declaring more than 5000 entries", async () => {
    const { dir, key } = await init();
    const blocks: Buffer[] = [];
    for (let i = 0; i < 5001; i++) blocks.push(await header(`f${String(i)}`, 0));
    const tgz = await craft("many.tgz", blocks);
    expect(await runRegistryMaintain(["add", dir, tgz, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("entries");
    expect(rootListing(dir)).toEqual([]);
    expect(readIndexFile(join(dir, "index.json")).sequence).toBe(1);
  });

  test("refuses an archive containing a symlink entry", async () => {
    const { dir, key } = await init();
    const { Header } = await import("tar");
    const link = Buffer.alloc(512);
    new Header({ path: "evil", type: "SymbolicLink", linkpath: "/etc/passwd", mode: 0o777 }).encode(
      link,
      0,
    );
    const tgz = await craft("link.tgz", [link]);
    expect(await runRegistryMaintain(["add", dir, tgz, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("evil is a symlink");
    expect(rootListing(dir)).toEqual([]);
    expect(readIndexFile(join(dir, "index.json")).sequence).toBe(1);
  });

  test("refuses an archive whose declared sizes exceed 200 MiB", async () => {
    const { dir, key } = await init();
    const tgz = await craft("big.tgz", [await header("big", 300 * 1024 * 1024)]);
    expect(await runRegistryMaintain(["add", dir, tgz, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("200 MiB");
    expect(rootListing(dir)).toEqual([]);
  });
});

describe("registry maintain revoke-key / takedown / set-report-url (trust layer PR 4a)", () => {
  const PUB_SEED = new Uint8Array(32).fill(51);
  const fpOf = (seed: Uint8Array): string =>
    publisherKeyFingerprint(encodeBase64(publicKeyFromSeed(seed)));

  async function registryWithExtension() {
    const { dir, key } = await init();
    await runRegistryMaintain(
      ["add", dir, await makeExtension("a", { seed: PUB_SEED }), "--key", key],
      io,
    );
    return { dir, key };
  }

  test("revoke-key signs a registry-root revocation into the index and re-signs it", async () => {
    const { dir, key } = await registryWithExtension();
    const code = await runRegistryMaintain(
      [
        "revoke-key",
        dir,
        fpOf(PUB_SEED),
        "--publisher",
        "example",
        "--reason",
        "leaked",
        "--key",
        key,
      ],
      io,
    );
    expect(code).toBe(0);
    const index = readIndexFile(join(dir, "index.json"));
    expect(verifyIndexSignature(index)).toBe(true);
    const [s] = (index.statements as unknown[]) ?? [];
    expect(s).toMatchObject({
      kind: "key.revoke",
      keyFingerprint: fpOf(PUB_SEED),
      reason: "leaked",
    });
    expect(verifyTrustStatement(parseTrustStatement(s), { registryRootKey: index.rootKey })).toBe(
      "registry",
    );
  });

  test("running it again is a no-op that says the block is already there", async () => {
    const { dir, key } = await registryWithExtension();
    const args = [
      "revoke-key",
      dir,
      fpOf(PUB_SEED),
      "--publisher",
      "example",
      "--reason",
      "leaked",
      "--key",
      key,
    ];
    await runRegistryMaintain(args, io);
    const sequence = readIndexFile(join(dir, "index.json")).sequence;
    out.length = 0;
    expect(await runRegistryMaintain(args, io)).toBe(0);
    expect(out.join("")).toContain("already");
    expect(readIndexFile(join(dir, "index.json")).sequence).toBe(sequence);
  });

  test("takedown takes the publisher the index binds; an unindexed id needs --publisher", async () => {
    const { dir, key } = await registryWithExtension();
    expect(
      await runRegistryMaintain(
        ["takedown", dir, "com.example.tool@1.0.0", "--reason", "malware", "--key", key],
        io,
      ),
    ).toBe(0);
    const [s] = (readIndexFile(join(dir, "index.json")).statements as unknown[]) ?? [];
    expect(s).toMatchObject({
      kind: "extension.takedown",
      extensionId: "com.example.tool",
      publisherId: "example",
      versions: ["1.0.0"],
    });
    err.length = 0;
    expect(
      await runRegistryMaintain(
        ["takedown", dir, "gone.tool", "--reason", "malware", "--key", key],
        io,
      ),
    ).toBe(2);
    expect(err.join("")).toContain("--publisher");
  });

  test("--github writes a request file into the clone and touches no index", async () => {
    const clone = join(tmp, "clone");
    mkdirSync(clone, { recursive: true });
    const code = await runRegistryMaintain(
      ["takedown", "--github", clone, "com.example.tool", "--reason", "malware"],
      io,
    );
    expect(code).toBe(0);
    const files = readdirSync(join(clone, "trust-requests"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^takedown-com\.example\.tool-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(readFileSync(join(clone, "trust-requests", files[0] ?? ""), "utf8"))).toEqual(
      {
        kind: "extension.takedown",
        extensionId: "com.example.tool",
        versions: "*",
        reason: "malware",
      },
    );
    expect(out.join("")).toContain("pull request");
    // The identical request again: already requested, nothing written.
    out.length = 0;
    expect(
      await runRegistryMaintain(
        ["takedown", "--github", clone, "com.example.tool", "--reason", "malware"],
        io,
      ),
    ).toBe(0);
    expect(out.join("")).toContain("already requested");
    expect(readdirSync(join(clone, "trust-requests"))).toHaveLength(1);
    // A different block for the same id (another version) gets its own file.
    expect(
      await runRegistryMaintain(
        ["takedown", "--github", clone, "com.example.tool@1.1.0", "--reason", "malware"],
        io,
      ),
    ).toBe(0);
    expect(readdirSync(join(clone, "trust-requests"))).toHaveLength(2);
  });

  test("--github names a request for a long extension id within the 64-character limit", async () => {
    const clone = join(tmp, "clone");
    mkdirSync(clone, { recursive: true });
    const longId = `com.example.${"a".repeat(60)}`;
    expect(
      await runRegistryMaintain(
        ["takedown", "--github", clone, longId, "--reason", "malware", "--publisher", "acme"],
        io,
      ),
    ).toBe(0);
    const files = readdirSync(join(clone, "trust-requests"));
    expect(files).toHaveLength(1);
    expect((files[0] ?? "").replace(/\.json$/, "").length).toBeLessThanOrEqual(64);
  });

  test("set-report-url sets an https report URL; init --report-url too; http is refused", async () => {
    const { dir, key } = await init();
    expect(
      await runRegistryMaintain(
        ["set-report-url", dir, "https://example.com/report", "--key", key],
        io,
      ),
    ).toBe(0);
    expect(readIndexFile(join(dir, "index.json")).reportUrl).toBe("https://example.com/report");
    expect(
      await runRegistryMaintain(
        ["set-report-url", dir, "http://example.com/report", "--key", key],
        io,
      ),
    ).toBe(2);
    const second = join(tmp, "reg2");
    expect(
      await runRegistryMaintain(
        ["init", second, "--key", join(tmp, "reg2-key"), "--report-url", "https://example.com/r2"],
        io,
      ),
    ).toBe(0);
    expect(readIndexFile(join(second, "index.json")).reportUrl).toBe("https://example.com/r2");
  });

  test("USAGE lists set-liveness-key, --report-url and --liveness-key", async () => {
    expect(await runRegistryMaintain(["nope"], io)).toBe(2);
    const usage = err.join("");
    expect(usage).toContain("set-liveness-key");
    expect(usage).toContain("--report-url");
    expect(usage).toContain("--liveness-key");
  });
});

describe("registry maintain set-liveness-key", () => {
  const PUB_SEED = new Uint8Array(32).fill(52);
  const livenessPub = (seedFill: number): string =>
    encodeBase64(publicKeyFromSeed(new Uint8Array(32).fill(seedFill)));

  async function populated() {
    const { dir, key } = await init();
    expect(
      await runRegistryMaintain(
        ["add", dir, await makeExtension("a", { seed: PUB_SEED }), "--key", key],
        io,
      ),
    ).toBe(0);
    expect(
      await runRegistryMaintain(["set-report-url", dir, "https://example.com/r", "--key", key], io),
    ).toBe(0);
    const fp = publisherKeyFingerprint(encodeBase64(publicKeyFromSeed(PUB_SEED)));
    expect(
      await runRegistryMaintain(
        ["revoke-key", dir, fp, "--publisher", "example", "--reason", "leaked", "--key", key],
        io,
      ),
    ).toBe(0);
    out.length = 0;
    return { dir, key };
  }

  test("an existing registry opts in: every field is carried and only livenessKey is added", async () => {
    const { dir, key } = await populated();
    const before = readIndexFile(join(dir, "index.json"));
    const pub = livenessPub(7);
    expect(await runRegistryMaintain(["set-liveness-key", dir, pub, "--key", key], io)).toBe(0);
    const after = readIndexFile(join(dir, "index.json"));
    expect(verifyIndexSignature(after)).toBe(true);
    expect(after.sequence).toBe(before.sequence + 1);
    expect(after.livenessKey).toBe(pub);
    const { signature: _a, sequence: _b, generatedAt: _c, livenessKey: _d, ...rest } = after;
    const { signature: _e, sequence: _f, generatedAt: _g, ...was } = before;
    expect(rest).toEqual(was);
    expect(after.reportUrl).toBe("https://example.com/r");
    expect(Array.isArray(after.statements)).toBe(true);
    expect(Object.keys(after.extensions)).toEqual(Object.keys(before.extensions));
    expect(out.join("")).toContain(`liveness fingerprint: ${publisherKeyFingerprint(pub)}`);
  });

  test("a later add carries the liveness key", async () => {
    const { dir, key } = await populated();
    const pub = livenessPub(8);
    await runRegistryMaintain(["set-liveness-key", dir, pub, "--key", key], io);
    const ext = await makeExtension("b", { seed: PUB_SEED, version: "1.1.0" });
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(0);
    expect(readIndexFile(join(dir, "index.json")).livenessKey).toBe(pub);
  });

  test.each([
    ["not base64 of 32 bytes", "abc"],
    ["44 characters with no padding", "A".repeat(44)],
    ["43 characters then a letter", `${"A".repeat(43)}A`],
  ])("refuses a public key that is %s", async (_what, bad) => {
    const { dir, key } = await init();
    const before = readFileSync(join(dir, "index.json"), "utf8");
    expect(await runRegistryMaintain(["set-liveness-key", dir, bad, "--key", key], io)).toBe(2);
    expect(readFileSync(join(dir, "index.json"), "utf8")).toBe(before);
  });

  test("refuses the registry's own root key as the liveness key", async () => {
    const { dir, key } = await init();
    const root = readIndexFile(join(dir, "index.json")).rootKey;
    const before = readFileSync(join(dir, "index.json"), "utf8");
    expect(await runRegistryMaintain(["set-liveness-key", dir, root, "--key", key], io)).toBe(2);
    expect(err.join("")).toContain("root key");
    expect(readFileSync(join(dir, "index.json"), "utf8")).toBe(before);
  });

  /** The same 32 bytes spelled with non-zero padding bits in the last character. */
  const alias = (k: string): string => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    return `${k.slice(0, 42)}${chars[chars.indexOf(k[42] as string) + 1]}=`;
  };

  test("a non-canonical alias of the root key is refused as the root key", async () => {
    const { dir, key } = await init();
    const root = readIndexFile(join(dir, "index.json")).rootKey;
    const before = readFileSync(join(dir, "index.json"), "utf8");
    expect(alias(root)).not.toBe(root);
    expect(Buffer.from(alias(root), "base64").equals(Buffer.from(root, "base64"))).toBe(true);
    expect(
      await runRegistryMaintain(["set-liveness-key", dir, alias(root), "--key", key], io),
    ).toBe(2);
    expect(err.join("")).toContain("root key");
    expect(readFileSync(join(dir, "index.json"), "utf8")).toBe(before);
  });

  test("a non-canonical liveness key is refused as malformed", async () => {
    const { dir, key } = await init();
    expect(
      await runRegistryMaintain(["set-liveness-key", dir, alias(livenessPub(3)), "--key", key], io),
    ).toBe(2);
    expect(err.join("")).toContain("canonical");
  });

  test("--generate says to keep the key file outside every clone", async () => {
    const { dir, key } = await init();
    await runRegistryMaintain(
      ["set-liveness-key", dir, "--generate", "--liveness-key", join(tmp, "lk2"), "--key", key],
      io,
    );
    expect(out.join("")).toContain("outside every clone");
  });

  test("needs exactly one of a public key and --generate", async () => {
    const { dir, key } = await init();
    expect(await runRegistryMaintain(["set-liveness-key", dir, "--key", key], io)).toBe(2);
    expect(
      await runRegistryMaintain(
        ["set-liveness-key", dir, livenessPub(9), "--generate", "--key", key],
        io,
      ),
    ).toBe(2);
  });

  test("--generate writes a 0600 key file, signs its public half, prints no seed, and needs --force to overwrite", async () => {
    const { dir, key } = await init();
    const lk = join(tmp, "lk");
    expect(
      await runRegistryMaintain(
        ["set-liveness-key", dir, "--generate", "--liveness-key", lk, "--key", key],
        io,
      ),
    ).toBe(0);
    const seedText = readFileSync(lk, "utf8").trim();
    const pub = encodeBase64(publicKeyFromSeed(new Uint8Array(Buffer.from(seedText, "base64"))));
    expect(readIndexFile(join(dir, "index.json")).livenessKey).toBe(pub);
    expect(out.join("")).not.toContain(seedText);
    expect(out.join("")).toContain(lk);
    if (process.platform !== "win32") expect(statSync(lk).mode & 0o777).toBe(0o600);
    const sequence = readIndexFile(join(dir, "index.json")).sequence;
    err.length = 0;
    expect(
      await runRegistryMaintain(
        ["set-liveness-key", dir, "--generate", "--liveness-key", lk, "--key", key],
        io,
      ),
    ).toBe(2);
    expect(err.join("")).toContain("without --force");
    expect(readFileSync(lk, "utf8").trim()).toBe(seedText);
    expect(readIndexFile(join(dir, "index.json")).sequence).toBe(sequence);
    expect(
      await runRegistryMaintain(
        ["set-liveness-key", dir, "--generate", "--liveness-key", lk, "--force", "--key", key],
        io,
      ),
    ).toBe(0);
    expect(readFileSync(lk, "utf8").trim()).not.toBe(seedText);
  });

  test("--generate refuses a key path inside <dir> or equal to the root key", async () => {
    const { dir, key } = await init();
    for (const lk of [join(dir, "lk"), key]) {
      err.length = 0;
      expect(
        await runRegistryMaintain(
          ["set-liveness-key", dir, "--generate", "--liveness-key", lk, "--key", key, "--force"],
          io,
        ),
      ).toBe(2);
      expect(readIndexFile(join(dir, "index.json")).sequence).toBe(1);
    }
    expect(existsSync(join(dir, "lk"))).toBe(false);
  });

  test("refuses when the root key is the wrong one", async () => {
    const { dir } = await init();
    const other = join(tmp, "other-key");
    writeFileSync(other, `${encodeBase64(generateEd25519Keypair().privkey)}\n`);
    expect(
      await runRegistryMaintain(["set-liveness-key", dir, livenessPub(5), "--key", other], io),
    ).toBe(2);
    expect(err.join("")).toContain("different key");
  });
});

describe("registry maintain add --scores", () => {
  const QUALITY = {
    scorer: 1,
    score: 50,
    cases: 2,
    passed: 1,
    rubrics: {
      exact: { cases: 2, passed: 1 },
      "json-match": { cases: 0, passed: 0 },
      "one-of": { cases: 0, passed: 0 },
    },
  };
  const BASELINE = { scorer: 1, passed: true, tools: 3 };
  const ID_VERSION = "com.example.tool@1.0.0";

  /** The sha256 of the bytes `maintain add` publishes for this directory. */
  async function packedSha(extDir: string): Promise<string> {
    const tgz = join(tmp, "probe.tgz");
    await packExtensionDir(extDir, tgz);
    return sha(readFileSync(tgz));
  }

  function writeScores(entries: Record<string, unknown>): string {
    const path = join(tmp, "scores.json");
    writeFileSync(path, JSON.stringify(entries));
    return path;
  }

  function versionOf(dir: string) {
    return readIndexFile(join(dir, "index.json")).extensions["com.example.tool"]?.versions["1.0.0"];
  }

  /** Everything a refused add must leave alone. */
  function folderState(dir: string): { index: string; hasExtension: boolean } {
    return {
      index: readFileSync(join(dir, "index.json"), "utf8"),
      hasExtension: existsSync(join(dir, "extensions", "com.example.tool")),
    };
  }

  async function expectRefusedAdd(dir: string, args: string[], message: string): Promise<void> {
    const before = folderState(dir);
    err.length = 0;
    expect(await runRegistryMaintain(["add", dir, ...args], io)).toBe(2);
    expect(err.join("")).toContain(message);
    expect(folderState(dir)).toEqual(before);
  }

  async function addWith(dir: string, key: string, ext: string, scores: string): Promise<number> {
    return await runRegistryMaintain(["add", dir, ext, "--scores", scores, "--key", key], io);
  }

  test("a valid quality and baseline are both signed into the entry", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    const scores = writeScores({
      [ID_VERSION]: { packageSha256: await packedSha(ext), quality: QUALITY, baseline: BASELINE },
    });
    expect(await addWith(dir, key, ext, scores)).toBe(0);
    expect(verifyIndexSignature(readIndexFile(join(dir, "index.json")))).toBe(true);
    expect(versionOf(dir)?.quality).toEqual(QUALITY);
    expect(versionOf(dir)?.baseline).toEqual(BASELINE);
    expect(out.join("")).toContain(", quality 50/100, baseline passed");
  });

  test("a suite package with no entry is refused and the folder is untouched", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    await expectRefusedAdd(
      dir,
      [ext, "--scores", writeScores({}), "--key", key],
      "refusing to add com.example.tool@1.0.0",
    );
  });

  test("another package hash is refused the same way", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    const scores = writeScores({
      [ID_VERSION]: { packageSha256: "0".repeat(64), quality: QUALITY },
    });
    await expectRefusedAdd(
      dir,
      [ext, "--scores", scores, "--key", key],
      "refusing to add com.example.tool@1.0.0",
    );
  });

  test("an unreadable or non-JSON file refuses before the package is read", async () => {
    const { dir, key } = await init();
    const notJson = join(tmp, "bad.json");
    writeFileSync(notJson, "{nope");
    // The source does not exist: were it read first, the refusal would be about the source.
    const missingSource = join(tmp, "no-such-extension");
    for (const file of [notJson, join(tmp, "absent.json")]) {
      await expectRefusedAdd(
        dir,
        [missingSource, "--scores", file, "--key", key],
        "refusing to sign: the scores input",
      );
    }
  });

  test("a no-suite package with a valid baseline signs the baseline", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext");
    const scores = writeScores({
      [ID_VERSION]: { packageSha256: await packedSha(ext), baseline: BASELINE },
    });
    expect(await addWith(dir, key, ext, scores)).toBe(0);
    expect(versionOf(dir)?.baseline).toEqual(BASELINE);
    expect(versionOf(dir)).not.toHaveProperty("quality");
    expect(out.join("")).toContain(", baseline passed");
    expect(out.join("")).not.toContain("quality");
  });

  test("a failed baseline is signed and reported as failed", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext");
    const failed = { scorer: 1, passed: false, tools: 0, failure: "no-listing" };
    const scores = writeScores({
      [ID_VERSION]: { packageSha256: await packedSha(ext), baseline: failed },
    });
    expect(await addWith(dir, key, ext, scores)).toBe(0);
    expect(versionOf(dir)?.baseline).toEqual(failed);
    expect(out.join("")).toContain(", baseline failed");
  });

  test("a malformed baseline beside a valid quality signs the quality and says so", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    const scores = writeScores({
      [ID_VERSION]: {
        packageSha256: await packedSha(ext),
        quality: QUALITY,
        baseline: { scorer: 1, passed: true },
      },
    });
    expect(await addWith(dir, key, ext, scores)).toBe(0);
    expect(versionOf(dir)?.quality).toEqual(QUALITY);
    expect(versionOf(dir)).not.toHaveProperty("baseline");
    const text = out.join("");
    expect(text).not.toContain(", baseline passed");
    const ignored = text.split("\n").filter((l) => l.includes("baseline is invalid"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain("signed without a baseline");
  });

  test("nothing from the scores file path reaches the terminal as a control character", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    // The path is the owner's argument, yet the error that names it must stay on one safe line.
    const hostile = join(tmp, "scores\u001b[31m\nforged.json");
    err.length = 0;
    expect(await addWith(dir, key, ext, hostile)).toBe(2);
    const text = err.join("");
    expect(text).not.toContain("\u001b");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
  });

  test("a missing --scores value is a usage error", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext");
    await expectRefusedAdd(dir, [ext, "--key", key, "--scores"], "--scores needs a value");
  });

  test("without --scores neither field is written", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    expect(await runRegistryMaintain(["add", dir, ext, "--key", key], io)).toBe(0);
    expect(versionOf(dir)).not.toHaveProperty("quality");
    expect(versionOf(dir)).not.toHaveProperty("baseline");
    expect(out.join("")).not.toContain("baseline");
  });

  test("a score file keyed on a directory packed bytes matches that directory", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension("ext", { suite: true });
    const scores = writeScores({
      [ID_VERSION]: { packageSha256: await packedSha(ext), quality: QUALITY },
    });
    expect(await addWith(dir, key, ext, scores)).toBe(0);
    expect(versionOf(dir)?.packageSha256).toBe(await packedSha(ext));
    expect(versionOf(dir)?.quality).toEqual(QUALITY);
  });
});
