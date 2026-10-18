/**
 * Refusal paths and multi-version flows of `nimbus registry maintain`, beyond the happy paths in
 * `registry-maintain.test.ts`. Every case runs against a fresh temp dir and asserts both the exit
 * code and that a refused command left the registry exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { verifyIndexSignature } from "@nimbus-dev/registry-format";
import { Header, create as tarCreate } from "tar";
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
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-maintain-cov-"));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

type Keypair = { privkey: Uint8Array; pubkey: Uint8Array };

interface ExtOpts {
  /** Publisher keypair; a fresh one when omitted. */
  pair?: Keypair;
  /** Applied to the manifest BEFORE signing. */
  edit?: (m: Record<string, unknown>) => void;
  /** Applied to the manifest AFTER signing (so the signature no longer matches, if it touches it). */
  postSign?: (m: Record<string, unknown>) => void;
  /** Raw text to write as the manifest instead of the JSON document. */
  rawManifest?: string;
  /** Write no entry file. */
  noEntry?: boolean;
}

let extCounter = 0;
async function makeExtension(opts: ExtOpts = {}): Promise<string> {
  const dir = join(tmp, `ext-${String(extCounter++)}`);
  mkdirSync(join(dir, "dist"), { recursive: true });
  if (opts.noEntry !== true) writeFileSync(join(dir, "dist", "index.js"), "export default 1;\n");
  const pair = opts.pair ?? generateEd25519Keypair();
  const manifest: Record<string, unknown> = {
    id: "com.example.tool",
    name: "Example Tool",
    version: "1.0.0",
    entry: "dist/index.js",
    permissions: {},
    publisher: { id: "example", key: encodeBase64(pair.pubkey) },
  };
  opts.edit?.(manifest);
  manifest["signature"] = await signManifest(manifest, pair.privkey);
  opts.postSign?.(manifest);
  writeFileSync(
    join(dir, "nimbus.extension.json"),
    opts.rawManifest ?? JSON.stringify(manifest, null, 2),
  );
  return dir;
}

async function init(name = "reg"): Promise<{ dir: string; key: string }> {
  const dir = join(tmp, name);
  const key = join(tmp, `${name}-key`);
  expect(await runRegistryMaintain(["init", dir, "--key", key], io)).toBe(0);
  out.length = 0;
  err.length = 0;
  return { dir, key };
}

/** Run, expect `code`, and return stderr. */
async function run(args: string[], code: number): Promise<string> {
  err.length = 0;
  expect(await runRegistryMaintain(args, io)).toBe(code);
  return err.join("");
}

function indexText(dir: string): string {
  return readFileSync(join(dir, "index.json"), "utf8");
}

describe("registry maintain argument parsing", () => {
  test("a valued option at the end of argv needs a value", async () => {
    expect(await run(["init", join(tmp, "r"), "--key"], 2)).toContain("--key needs a value");
    expect(existsSync(join(tmp, "r"))).toBe(false);
  });

  test("a valued option followed by another option needs a value", async () => {
    expect(await run(["init", join(tmp, "r"), "--key", "--force"], 2)).toContain(
      "--key needs a value",
    );
  });

  test("an unknown option is refused", async () => {
    expect(await run(["init", join(tmp, "r"), "--frobnicate"], 2)).toContain(
      "unknown option --frobnicate",
    );
    expect(existsSync(join(tmp, "r"))).toBe(false);
  });

  test("a boolean flag from another subcommand is unknown to it", async () => {
    const { dir, key } = await init();
    expect(await run(["remove", dir, "x", "--key", key, "--force"], 2)).toContain(
      "unknown option --force",
    );
  });

  test("init needs exactly one <dir>", async () => {
    expect(await run(["init"], 2)).toContain("init needs <dir>");
    expect(await run(["init", join(tmp, "a"), join(tmp, "b")], 2)).toContain("init needs <dir>");
  });

  test("add needs exactly <dir> <source>", async () => {
    expect(await run(["add", join(tmp, "r")], 2)).toContain("add needs <dir>");
    expect(await run(["add", "a", "b", "c"], 2)).toContain("add needs <dir>");
  });

  test("remove needs exactly <dir> <id>", async () => {
    expect(await run(["remove", join(tmp, "r")], 2)).toContain("remove needs <dir>");
    expect(await run(["remove", "a", "b", "c"], 2)).toContain("remove needs <dir>");
  });

  test("--channel accepts only stable or beta", async () => {
    expect(await run(["add", "a", "b", "--channel", "nightly"], 2)).toContain(
      "--channel must be stable or beta",
    );
  });
});

describe("registry maintain init", () => {
  test("init refuses an existing index.json without --force and keeps it", async () => {
    const { dir } = await init();
    const before = indexText(dir);
    const msg = await run(["init", dir, "--key", join(tmp, "fresh-key")], 2);
    expect(msg).toContain("refusing to overwrite without --force");
    expect(indexText(dir)).toBe(before);
    expect(existsSync(join(tmp, "fresh-key"))).toBe(false);
  });

  test("init --force re-initialises over an existing index with a new key", async () => {
    const { dir, key } = await init();
    const oldRoot = readIndexFile(join(dir, "index.json")).rootKey;
    expect(await run(["init", dir, "--key", key, "--force"], 0)).toBe("");
    const index = readIndexFile(join(dir, "index.json"));
    expect(index.rootKey).not.toBe(oldRoot);
    expect(index.sequence).toBe(1);
    expect(verifyIndexSignature(index)).toBe(true);
  });

  test("a key path that cannot be written is an unexpected error (exit 1)", async () => {
    // The key's parent directory is a regular file, so creating it fails with a raw fs error.
    const parentFile = join(tmp, "parent-is-a-file");
    writeFileSync(parentFile, "x");
    const msg = await run(["init", join(tmp, "r"), "--key", join(parentFile, "key")], 1);
    expect(msg).not.toBe("");
    expect(existsSync(join(tmp, "r", "index.json"))).toBe(false);
  });
});

describe("registry maintain key and index preconditions", () => {
  test("a missing key file is refused", async () => {
    const { dir } = await init();
    expect(await run(["remove", dir, "x", "--key", join(tmp, "no-such-key")], 2)).toContain(
      "could not read key file",
    );
  });

  test("a key file that does not decode to 32 bytes is refused", async () => {
    const { dir } = await init();
    const short = join(tmp, "short-key");
    writeFileSync(short, `${encodeBase64(new Uint8Array(16))}\n`);
    expect(await run(["remove", dir, "x", "--key", short], 2)).toContain(
      "did not decode to 32 bytes",
    );
  });

  test("a folder with no index.json says to run init", async () => {
    const { key } = await init();
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    expect(await run(["remove", empty, "x", "--key", key], 2)).toContain("run `maintain init`");
  });

  test("a tampered index.json is refused before anything changes", async () => {
    const { dir, key } = await init();
    const index = JSON.parse(indexText(dir)) as Record<string, unknown>;
    index["sequence"] = 99;
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    const before = indexText(dir);
    expect(await run(["remove", dir, "x", "--key", key], 2)).toContain("does not verify");
    expect(indexText(dir)).toBe(before);
  });

  test("a structurally broken index.json is an unexpected error (exit 1)", async () => {
    const { dir, key } = await init();
    writeFileSync(join(dir, "index.json"), "[]");
    expect(await run(["remove", dir, "x", "--key", key], 1)).toContain(
      "is not a registry index object",
    );
  });
});

describe("registry maintain add — package and manifest refusals", () => {
  async function refuses(source: string, expected: string): Promise<void> {
    const { dir, key } = await init(`reg-${String(extCounter)}`);
    const before = indexText(dir);
    expect(await run(["add", dir, source, "--key", key], 2)).toContain(expected);
    expect(indexText(dir)).toBe(before);
  }

  test("an empty package file is out of range", async () => {
    const empty = join(tmp, "empty.tgz");
    writeFileSync(empty, "");
    await refuses(empty, "package size is out of range");
  });

  test("a package with no manifest at its root", async () => {
    const dir = join(tmp, "bare");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "1");
    await refuses(dir, "package has no nimbus.extension.json at its root");
  });

  test("a manifest that is not JSON", async () => {
    await refuses(await makeExtension({ rawManifest: "{nope" }), "manifest is not valid JSON");
  });

  test("a manifest that is a JSON array", async () => {
    await refuses(await makeExtension({ rawManifest: "[1]" }), "manifest is not a JSON object");
  });

  test("a manifest that is JSON null", async () => {
    await refuses(await makeExtension({ rawManifest: "null" }), "manifest is not a JSON object");
  });

  test("a manifest over 64 KiB", async () => {
    await refuses(
      await makeExtension({ rawManifest: JSON.stringify({ pad: "x".repeat(70 * 1024) }) }),
      "manifest is too large",
    );
  });

  test("a declared entry that is missing", async () => {
    await refuses(await makeExtension({ noEntry: true }), "extension entry dist/index.js");
  });

  test("an omitted entry falls back to dist/index.js (missing here)", async () => {
    await refuses(
      await makeExtension({ noEntry: true, edit: (m) => delete m["entry"] }),
      "extension entry dist/index.js is missing",
    );
  });

  test("an entry that escapes the package", async () => {
    await refuses(
      await makeExtension({ edit: (m) => (m["entry"] = "../outside.js") }),
      "extension entry ../outside.js is missing or outside the package",
    );
  });

  test("a manifest with no id", async () => {
    await refuses(
      await makeExtension({ edit: (m) => delete m["id"] }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  for (const id of ["a/../b", "a//b", "a\\b", " ", "x".repeat(129)]) {
    test(`an unsafe id ${JSON.stringify(id.slice(0, 12))}`, async () => {
      await refuses(
        await makeExtension({ edit: (m) => (m["id"] = id) }),
        "ERR_REGISTRY_MANIFEST_INVALID",
      );
    });
  }

  for (const version of ["v1.0.0", "1.0", 7]) {
    test(`a non-semver version ${JSON.stringify(version)}`, async () => {
      await refuses(
        await makeExtension({ edit: (m) => (m["version"] = version) }),
        "ERR_REGISTRY_MANIFEST_INVALID",
      );
    });
  }

  test("a manifest without a signature is unsigned", async () => {
    await refuses(
      await makeExtension({ postSign: (m) => delete m["signature"] }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  test("a manifest whose publisher has no key is unsigned", async () => {
    await refuses(
      await makeExtension({ postSign: (m) => (m["publisher"] = { id: "example" }) }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  test("a manifest with a null publisher is unsigned", async () => {
    await refuses(
      await makeExtension({ postSign: (m) => (m["publisher"] = null) }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  test("a malformed publisher id", async () => {
    await refuses(
      await makeExtension({
        edit: (m) => (m["publisher"] = { ...(m["publisher"] as object), id: "Bad Id" }),
      }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  test("a publisher id over 64 chars", async () => {
    await refuses(
      await makeExtension({
        edit: (m) => (m["publisher"] = { ...(m["publisher"] as object), id: "a".repeat(65) }),
      }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  test("a malformed publisher key", async () => {
    await refuses(
      await makeExtension({
        postSign: (m) => (m["publisher"] = { id: "example", key: "not-a-key" }),
      }),
      "ERR_REGISTRY_MANIFEST_INVALID",
    );
  });

  test("a signature that does not verify", async () => {
    await refuses(
      await makeExtension({ postSign: (m) => (m["version"] = "9.9.9") }),
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
  });

  test("an archive with a hardlink entry", async () => {
    const link = Buffer.alloc(512);
    new Header({ path: "hard", type: "Link", linkpath: "other", mode: 0o644 }).encode(link, 0);
    const tgz = join(tmp, "hard.tgz");
    writeFileSync(tgz, gzipSync(Buffer.concat([link, Buffer.alloc(1024)])));
    await refuses(tgz, "package entry hard is a hardlink");
  });

  test("an archive with a character-device entry", async () => {
    const dev = Buffer.alloc(512);
    new Header({ path: "tty", type: "CharacterDevice", mode: 0o644 }).encode(dev, 0);
    const tgz = join(tmp, "dev.tgz");
    writeFileSync(tgz, gzipSync(Buffer.concat([dev, Buffer.alloc(1024)])));
    await refuses(tgz, "package entry tty is a CharacterDevice entry");
  });
});

describe("registry maintain add/remove — multi-version flows", () => {
  test("add a beta version under the same publisher key, then remove one version keeps the other", async () => {
    const { dir, key } = await init();
    const pair = generateEd25519Keypair();
    expect(await run(["add", dir, await makeExtension({ pair }), "--key", key], 0)).toBe("");
    expect(
      await run(
        [
          "add",
          dir,
          await makeExtension({ pair, edit: (m) => (m["version"] = "1.1.0-beta.1") }),
          "--channel",
          "beta",
          "--key",
          key,
        ],
        0,
      ),
    ).toBe("");
    expect(out.join("")).toContain("added com.example.tool@1.1.0-beta.1 (beta); sequence 3");
    let index = readIndexFile(join(dir, "index.json"));
    const ext = index.extensions["com.example.tool"];
    expect(Object.keys(ext?.versions ?? {}).sort()).toEqual(["1.0.0", "1.1.0-beta.1"]);
    expect(ext?.versions["1.1.0-beta.1"]?.channel).toBe("beta");

    expect(await run(["remove", dir, "com.example.tool@1.0.0", "--key", key], 0)).toBe("");
    expect(out.join("")).toContain("removed com.example.tool@1.0.0; sequence 4");
    index = readIndexFile(join(dir, "index.json"));
    expect(verifyIndexSignature(index)).toBe(true);
    expect(Object.keys(index.extensions["com.example.tool"]?.versions ?? {})).toEqual([
      "1.1.0-beta.1",
    ]);
    expect(index.extensions["com.example.tool"]?.publisher.key).toBe(encodeBase64(pair.pubkey));
  });

  test("remove without a version drops every version of the id", async () => {
    const { dir, key } = await init();
    const pair = generateEd25519Keypair();
    await run(["add", dir, await makeExtension({ pair }), "--key", key], 0);
    await run(
      [
        "add",
        dir,
        await makeExtension({ pair, edit: (m) => (m["version"] = "2.0.0") }),
        "--key",
        key,
      ],
      0,
    );
    expect(await run(["remove", dir, "com.example.tool", "--key", key], 0)).toBe("");
    expect(out.join("")).toContain("removed com.example.tool; sequence 4");
    expect(readIndexFile(join(dir, "index.json")).extensions).toEqual({});
  });

  test("an id containing @ but no semver suffix is treated as a whole id", async () => {
    const { dir, key } = await init();
    const pair = generateEd25519Keypair();
    await run(
      [
        "add",
        dir,
        await makeExtension({ pair, edit: (m) => (m["id"] = "acme@tools") }),
        "--key",
        key,
      ],
      0,
    );
    expect(await run(["remove", dir, "acme@tools", "--key", key], 0)).toBe("");
    expect(readIndexFile(join(dir, "index.json")).extensions).toEqual({});
  });

  test("a scoped id is stored under nested directories and named with its full path", async () => {
    const { dir, key } = await init();
    await run(
      ["add", dir, await makeExtension({ edit: (m) => (m["id"] = "acme/deploy") }), "--key", key],
      0,
    );
    const entry = readIndexFile(join(dir, "index.json")).extensions["acme/deploy"]?.versions[
      "1.0.0"
    ];
    expect(entry?.package).toBe("extensions/acme/deploy/1.0.0/package.tgz");
    expect(existsSync(join(dir, "extensions", "acme", "deploy", "1.0.0", "package.tgz"))).toBe(
      true,
    );
  });

  test("a manifest without a name is listed under its id", async () => {
    const { dir, key } = await init();
    await run(
      ["add", dir, await makeExtension({ edit: (m) => delete m["name"] }), "--key", key],
      0,
    );
    const entry = readIndexFile(join(dir, "index.json")).extensions["com.example.tool"]?.versions[
      "1.0.0"
    ];
    expect(entry?.name).toBe("com.example.tool");
  });

  test("remove of an unknown id is refused and the index is unchanged", async () => {
    const { dir, key } = await init();
    const before = indexText(dir);
    expect(await run(["remove", dir, "com.example.none", "--key", key], 2)).toContain(
      "com.example.none is not in this registry",
    );
    expect(indexText(dir)).toBe(before);
  });

  test("remove of an unknown version of a known id is refused", async () => {
    const { dir, key } = await init();
    await run(["add", dir, await makeExtension(), "--key", key], 0);
    const before = indexText(dir);
    expect(await run(["remove", dir, "com.example.tool@3.0.0", "--key", key], 2)).toContain(
      "com.example.tool@3.0.0 is not in this registry",
    );
    expect(indexText(dir)).toBe(before);
  });
});

describe("registry maintain add — parity with the shared publish validator", () => {
  test("a tampered index is refused before the validator runs", async () => {
    const { dir, key } = await init();
    const index = JSON.parse(indexText(dir)) as Record<string, unknown>;
    index["sequence"] = 99;
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    const before = indexText(dir);
    // A package the validator would refuse (unsigned) reports the index failure instead.
    const unsigned = await makeExtension({ postSign: (m) => delete m["signature"] });
    const msg = await run(["add", dir, unsigned, "--key", key], 2);
    expect(msg).toContain("does not verify");
    expect(msg).not.toContain("ERR_REGISTRY_");
    expect(indexText(dir)).toBe(before);
  });

  test("a registry that requires publisher namespaces refuses an id outside it", async () => {
    const { dir, key } = await init();
    writeFileSync(
      join(dir, "nimbus-registry.json"),
      JSON.stringify({ format: 1, requirePublisherNamespace: true }),
    );
    const msg = await run(["add", dir, await makeExtension(), "--key", key], 2);
    expect(msg).toContain("ERR_REGISTRY_NAMESPACE_REQUIRED");
  });

  test("a registry that requires namespaces accepts an id inside it", async () => {
    const { dir, key } = await init();
    writeFileSync(
      join(dir, "nimbus-registry.json"),
      JSON.stringify({ format: 1, requirePublisherNamespace: true }),
    );
    await run(
      ["add", dir, await makeExtension({ edit: (m) => (m["id"] = "example/tool") }), "--key", key],
      0,
    );
  });

  test("a malformed nimbus-registry.json is refused with its own code", async () => {
    const { dir, key } = await init();
    writeFileSync(join(dir, "nimbus-registry.json"), JSON.stringify({ format: 1 }));
    const msg = await run(["add", dir, await makeExtension(), "--key", key], 2);
    expect(msg).toContain("ERR_REGISTRY_CONFIG_INVALID");
  });

  test("a package holding a file outside the package set is refused", async () => {
    const { dir, key } = await init();
    const ext = await makeExtension();
    writeFileSync(join(ext, "secrets.env"), "X=1\n");
    const tgz = join(tmp, "extra.tgz");
    await tarCreate({ gzip: true, file: tgz, cwd: ext }, [
      "nimbus.extension.json",
      "dist",
      "secrets.env",
    ]);
    const msg = await run(["add", dir, tgz, "--key", key], 2);
    expect(msg).toContain("ERR_REGISTRY_PACKAGE_FILE_SET");
  });
});
