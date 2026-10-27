import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  opts: { version?: string; signed?: boolean; seed?: Uint8Array; id?: string } = {},
): Promise<string> {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
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
    expect(files).toEqual(["takedown-com.example.tool.json"]);
    expect(JSON.parse(readFileSync(join(clone, "trust-requests", files[0] ?? ""), "utf8"))).toEqual(
      {
        kind: "extension.takedown",
        extensionId: "com.example.tool",
        versions: "*",
        reason: "malware",
      },
    );
    expect(out.join("")).toContain("pull request");
    err.length = 0;
    expect(
      await runRegistryMaintain(
        ["takedown", "--github", clone, "com.example.tool", "--reason", "again"],
        io,
      ),
    ).toBe(2);
    expect(err.join("")).toContain("exists");
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
});
