import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packExtensionDir } from "@nimbus-dev/registry-format";
import { create as tarCreate } from "tar";

import type { IPCClient } from "../ipc-client/index.ts";
import { type CloneDeps, isStrictlyInside, runExtensionClone } from "./extension-clone.ts";

const ESC = String.fromCodePoint(0x1b);
const FINGERPRINT = "ab12cd34ef56";

let tmp: string;
let cwd: string;
let workTmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-clone-test-"));
  cwd = join(tmp, "cwd");
  workTmp = join(tmp, "work");
  mkdirSync(cwd);
  mkdirSync(workTmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseManifest(id: string): Record<string, unknown> {
  return {
    id,
    displayName: "Tool",
    version: "1.2.3",
    entry: "dist/index.js",
    license: "MIT",
    repository: "acme/tool",
    publisher: { id: "acme-pub", key: "PUBKEY" },
    signature: "SIGNATURE",
  };
}

interface Staged {
  archivePath: string;
  sha: string;
  stageDir: string;
}

/** Builds a real `.tgz` at `<tmp>/data/registry-clone-staging/c-test/package.tgz`. */
async function stage(manifest: Record<string, unknown>, stagePath?: string): Promise<Staged> {
  const src = mkdtempSync(join(tmp, "src-"));
  mkdirSync(join(src, "dist", "lib"), { recursive: true });
  writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  writeFileSync(join(src, "dist", "lib", "util.js"), "export const x = 1;\n");
  writeFileSync(join(src, "README.md"), "# Tool\n");
  const archivePath =
    stagePath ?? join(tmp, "data", "registry-clone-staging", "c-test", "package.tgz");
  const stageDir = join(archivePath, "..");
  mkdirSync(stageDir, { recursive: true });
  await packExtensionDir(src, archivePath);
  const sha = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  return { archivePath, sha, stageDir };
}

function reply(s: Staged, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme/tool",
    version: "1.2.3",
    channel: "stable",
    registry: "main",
    publisherId: "acme-pub",
    keyFingerprint: FINGERPRINT,
    verifiedPublisher: { github: "acme", verifiedAt: "2026-10-01T00:00:00.000Z" },
    packageSha256: s.sha,
    archivePath: s.archivePath,
    ...over,
  };
}

function harness(opts: { reply?: Record<string, unknown>; error?: Error } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let out = "";
  let err = "";
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (opts.error !== undefined) throw opts.error;
      if (method === "registry.cloneSource") return opts.reply;
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as IPCClient;
  const deps: CloneDeps = {
    client,
    cwd,
    tmpDir: workTmp,
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    log: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  };
  return { deps, calls, out: () => out, err: () => err };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("nimbus extension clone", () => {
  test("copies every file, strips the publisher identity, writes CLONED_FROM.md", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s) });
    const code = await runExtensionClone(["acme/tool"], h.deps);
    expect(code).toBe(0);
    const into = join(cwd, "tool");
    for (const f of ["nimbus.extension.json", "dist/index.js", "dist/lib/util.js", "README.md"]) {
      expect(existsSync(join(into, f))).toBe(true);
    }
    expect(readFileSync(join(into, "dist", "lib", "util.js"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    const raw = readFileSync(join(into, "nimbus.extension.json"), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    const m = JSON.parse(raw) as Record<string, unknown>;
    expect(m["signature"]).toBeUndefined();
    expect(m["publisher"]).toBeUndefined();
    expect(m["id"]).toBe("acme/tool");
    expect(m["version"]).toBe("1.2.3");
    const notes = readFileSync(join(into, "CLONED_FROM.md"), "utf8");
    expect(notes).toContain(FINGERPRINT);
    expect(notes).toContain("acme/tool");
    expect(notes).toContain("1.2.3");
    expect(notes).toContain("2026-11-04T12:00:00.000Z");
    expect(notes).toContain("https://github.com/acme/tool");
    expect(existsSync(s.archivePath)).toBe(false);
    expect(existsSync(s.stageDir)).toBe(false);
    expect(h.calls).toEqual([{ method: "registry.cloneSource", params: { id: "acme/tool" } }]);
    expect(h.out()).toContain(`Cloned acme/tool@1.2.3 from main into ${into}`);
    expect(h.out()).toContain(
      `Original publisher: acme-pub (key ${FINGERPRINT}), Verified publisher: @acme`,
    );
    expect(h.out()).toContain("License: MIT\n");
    expect(h.out()).not.toContain("Warning:");
    expect(h.out()).toContain("Source: https://github.com/acme/tool");
    expect(h.out()).toContain(`Install it unsigned with: nimbus extension install ${into}`);
    expect(h.out()).toContain(
      "(refused while acme/tool is installed: remove it first or clone with --publisher)",
    );
  });

  test("--registry and --version reach the gateway", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s) });
    const code = await runExtensionClone(
      ["acme/tool", "--registry", "main", "--version", "1.2.3"],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.calls[0]?.params).toEqual({ id: "acme/tool", registry: "main", version: "1.2.3" });
  });

  test("--publisher gives the copy a new id and publisher", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s) });
    const into = join(tmp, "mine");
    const code = await runExtensionClone(
      ["acme/tool", "--publisher", "acme", "--into", into],
      h.deps,
    );
    expect(code).toBe(0);
    const m = readJson(join(into, "nimbus.extension.json"));
    expect(m["id"]).toBe("acme/tool");
    expect(m["publisher"]).toEqual({ id: "acme" });
    expect(m["signature"]).toBeUndefined();
    expect(h.out()).toContain(
      `Sign it first: nimbus extension keygen (once), then nimbus extension sign ${into}`,
    );
    expect(h.out()).not.toContain("Install it unsigned");
  });

  test("--publisher with a different publisher rewrites the id", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s) });
    const code = await runExtensionClone(["acme/tool", "--publisher", "bob"], h.deps);
    expect(code).toBe(0);
    const m = readJson(join(cwd, "tool", "nimbus.extension.json"));
    expect(m["id"]).toBe("bob/tool");
    expect(m["publisher"]).toEqual({ id: "bob" });
  });

  test("an id with no '/' uses the whole id as the name", async () => {
    const s = await stage(baseManifest("tool"));
    const h = harness({ reply: reply(s, { id: "tool" }) });
    const code = await runExtensionClone(["tool", "--publisher", "acme"], h.deps);
    expect(code).toBe(0);
    const m = readJson(join(cwd, "tool", "nimbus.extension.json"));
    expect(m["id"]).toBe("acme/tool");
  });

  test("an invalid --publisher is refused before any IPC", async () => {
    const h = harness({});
    const code = await runExtensionClone(["acme/tool", "--publisher", "Bad.lock"], h.deps);
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain("--publisher must match");
  });

  test.each([
    [["acme/tool", "--bogus"]],
    [["acme/tool", "--into"]],
    [["acme/tool", "extra"]],
    [[]],
  ])("usage errors exit 2 with no IPC: %p", async (args) => {
    const h = harness({});
    expect(await runExtensionClone(args, h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain("Usage: nimbus extension clone");
  });

  test("a non-empty --into is refused before any IPC", async () => {
    const into = join(tmp, "busy");
    mkdirSync(into);
    writeFileSync(join(into, "keep.txt"), "x");
    const h = harness({});
    expect(await runExtensionClone(["acme/tool", "--into", into], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(`${into} already exists and is not empty`);
    expect(readFileSync(join(into, "keep.txt"), "utf8")).toBe("x");
  });

  test("a file at --into is refused before any IPC", async () => {
    const into = join(tmp, "afile");
    writeFileSync(into, "x");
    const h = harness({});
    expect(await runExtensionClone(["acme/tool", "--into", into], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(`${into} already exists and is not empty`);
  });

  test("a symlink at --into is refused before any IPC", async () => {
    const target = join(tmp, "target");
    mkdirSync(target);
    const into = join(tmp, "link");
    try {
      symlinkSync(target, into, "junction");
    } catch {
      // The OS refused to create a link here; nothing to test.
      return;
    }
    const h = harness({});
    expect(await runExtensionClone(["acme/tool", "--into", into], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(`${into} is a symbolic link`);
  });

  test("an existing empty --into is refused before any IPC", async () => {
    const into = join(tmp, "empty");
    mkdirSync(into);
    const h = harness({});
    expect(await runExtensionClone(["acme/tool", "--into", into], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(`${into} already exists; clone needs a new directory`);
  });

  test("a missing parent of --into is refused before any IPC", async () => {
    const into = join(tmp, "no", "such", "dir");
    const h = harness({});
    expect(await runExtensionClone(["acme/tool", "--into", into], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(`the parent of ${into} does not exist`);
  });

  test("an --into below a file (ENOTDIR on POSIX) is refused before any IPC", async () => {
    const file = join(tmp, "plain");
    writeFileSync(file, "x");
    const into = join(file, "sub");
    const h = harness({});
    expect(await runExtensionClone(["acme/tool", "--into", into], h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(`the parent of ${into} does not exist`);
  });

  test.each([["../x"], ["a//b"], [" a/b"]])(
    "an invalid source id %p exits 2 with no IPC",
    async (id) => {
      const h = harness({});
      expect(await runExtensionClone([id], h.deps)).toBe(2);
      expect(h.calls).toHaveLength(0);
    },
  );

  test("an archivePath outside the staging shape is neither read nor removed", async () => {
    const elsewhere = join(tmp, "elsewhere", "c-test", "package.tgz");
    const s = await stage(baseManifest("acme/tool"), elsewhere);
    const sentinel = join(s.stageDir, "sentinel.txt");
    writeFileSync(sentinel, "keep");
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain(
      "the gateway returned an unexpected staging path; nothing was written",
    );
    expect(existsSync(s.archivePath)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(existsSync(join(cwd, "tool"))).toBe(false);
  });

  test.each([
    ["a relative path", "registry-clone-staging/c-x/package.tgz"],
    ["the wrong basename", join("registry-clone-staging", "c-x", "other.tgz")],
    ["a parent without c-", join("registry-clone-staging", "d-x", "package.tgz")],
  ])("an archivePath with %s is refused", async (_label, rel) => {
    const h = harness({
      reply: {
        ...reply({ archivePath: "", sha: "", stageDir: "" }),
        archivePath: _label === "a relative path" ? rel : join(tmp, rel),
      },
    });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain("unexpected staging path");
  });

  test("a sha mismatch writes nothing and removes the staged entry", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s, { packageSha256: "0".repeat(64) }) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain("the staged package changed before it was read; nothing was written");
    expect(existsSync(join(cwd, "tool"))).toBe(false);
    expect(existsSync(s.archivePath)).toBe(false);
  });

  test("a registry error is printed cleaned and exits 1", async () => {
    const h = harness({ error: new Error(`ERR_REGISTRY_NOT_FOUND: no ${ESC}[31mtool`) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain("ERR_REGISTRY_NOT_FOUND: no [31mtool");
    expect(h.err()).not.toContain(ESC);
  });

  test.each([["ERR_EXTENSION_KEY_REVOKED: revoked"], ["ERR_EXTENSION_TAKEN_DOWN: taken down"]])(
    "a trust block (%s) exits 1",
    async (msg) => {
      const h = harness({ error: new Error(msg) });
      expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
      expect(h.err()).toContain(msg);
    },
  );

  test("any other error is rethrown", async () => {
    const h = harness({ error: new Error("socket closed") });
    await expect(runExtensionClone(["acme/tool"], h.deps)).rejects.toThrow("socket closed");
  });

  test.each([
    [
      "absent",
      undefined,
      "License: not declared",
      "Warning: no licence is declared; make sure the licence lets you modify and redistribute this code.",
    ],
    [
      "malformed",
      "MIT AND",
      "License: (invalid, ignored)",
      "Warning: the declared licence is malformed; make sure the licence lets you modify and redistribute this code.",
    ],
    [
      "non-OSI",
      "MIT OR LicenseRef-acme OR Proprietary-X",
      "License: MIT OR LicenseRef-acme OR Proprietary-X",
      "Warning: LicenseRef-acme, Proprietary-X is not an OSI-approved licence id; make sure the licence lets you modify and redistribute this code.",
    ],
  ])("licence %s warns", async (_label, license, licenseLine, warning) => {
    const manifest = baseManifest("acme/tool");
    if (license === undefined) delete manifest["license"];
    else manifest["license"] = license;
    const s = await stage(manifest);
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).toContain(`${licenseLine}\n`);
    expect(h.out()).toContain(`${warning}\n`);
  });

  test("no repository prints the built-JavaScript note; unverified publisher", async () => {
    const manifest = baseManifest("acme/tool");
    delete manifest["repository"];
    const s = await stage(manifest);
    const h = harness({ reply: reply(s, { verifiedPublisher: null }) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).toContain(
      "This copy is built JavaScript (dist/); the package names no source repository.",
    );
    expect(h.out()).toContain(`(key ${FINGERPRINT}), Unverified publisher`);
    const notes = readFileSync(join(cwd, "tool", "CLONED_FROM.md"), "utf8");
    expect(notes).not.toContain("github.com");
  });

  test("reply strings are printed cleaned", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({
      reply: reply(s, {
        registry: `ma${ESC}[2Jin`,
        publisherId: `acme${ESC}-pub`,
        verifiedPublisher: { github: `ac${ESC}me`, verifiedAt: "2026-10-01T00:00:00.000Z" },
      }),
    });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).not.toContain(ESC);
    expect(h.out()).toContain("from ma[2Jin into");
    expect(h.out()).toContain("Original publisher: acme-pub");
    expect(h.out()).toContain("Verified publisher: @acme");
    expect(readFileSync(join(cwd, "tool", "CLONED_FROM.md"), "utf8")).not.toContain(ESC);
  });

  test("--json prints the shape", async () => {
    const manifest = baseManifest("acme/tool");
    manifest["license"] = "LicenseRef-acme";
    const s = await stage(manifest);
    const h = harness({ reply: reply(s) });
    const into = join(tmp, "j");
    expect(
      await runExtensionClone(
        ["acme/tool", "--json", "--into", into, "--publisher", "bob"],
        h.deps,
      ),
    ).toBe(0);
    const j = JSON.parse(h.out()) as Record<string, unknown>;
    expect(j).toEqual({
      id: "acme/tool",
      version: "1.2.3",
      registry: "main",
      into,
      publisherId: "acme-pub",
      keyFingerprint: FINGERPRINT,
      verifiedPublisher: { github: "acme", verifiedAt: "2026-10-01T00:00:00.000Z" },
      license: "LicenseRef-acme",
      licenseWarning: "LicenseRef-acme is not an OSI-approved licence id",
      repository: "acme/tool",
      newId: "bob/tool",
      fundingRemoved: false,
    });
  });

  test("--publisher removes the original publisher's funding and says so", async () => {
    const manifest = baseManifest("acme/tool");
    manifest["funding"] = [{ url: "https://github.com/sponsors/acme" }];
    const s = await stage(manifest);
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool", "--publisher", "bob"], h.deps)).toBe(0);
    const m = readJson(join(cwd, "tool", "nimbus.extension.json"));
    expect(m["funding"]).toBeUndefined();
    const out = h.out();
    expect(out).toContain(
      "Source: https://github.com/acme/tool\nFunding links were removed; add your own before you publish.\n",
    );
  });

  test("--publisher --json reports fundingRemoved true", async () => {
    const manifest = baseManifest("acme/tool");
    manifest["funding"] = [{ url: "https://github.com/sponsors/acme" }];
    const s = await stage(manifest);
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool", "--json", "--publisher", "bob"], h.deps)).toBe(0);
    expect((JSON.parse(h.out()) as Record<string, unknown>)["fundingRemoved"]).toBe(true);
    expect(readJson(join(cwd, "tool", "nimbus.extension.json"))["funding"]).toBeUndefined();
  });

  test("without --publisher the funding is kept and nothing is said", async () => {
    const manifest = baseManifest("acme/tool");
    manifest["funding"] = [{ url: "https://github.com/sponsors/acme" }];
    const s = await stage(manifest);
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out()) as Record<string, unknown>)["fundingRemoved"]).toBe(false);
    expect(readJson(join(cwd, "tool", "nimbus.extension.json"))["funding"]).toEqual([
      { url: "https://github.com/sponsors/acme" },
    ]);
  });

  test("a --publisher clone with no funding says nothing about it", async () => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool", "--publisher", "bob"], h.deps)).toBe(0);
    expect(h.out()).not.toContain("Funding links");
  });

  test("--json with no publisher, licence or repository gives nulls", async () => {
    const manifest = baseManifest("acme/tool");
    delete manifest["repository"];
    const s = await stage(manifest);
    const h = harness({ reply: reply(s, { verifiedPublisher: null }) });
    expect(await runExtensionClone(["acme/tool", "--json"], h.deps)).toBe(0);
    const j = JSON.parse(h.out()) as Record<string, unknown>;
    expect(j["licenseWarning"]).toBeNull();
    expect(j["repository"]).toBeNull();
    expect(j["newId"]).toBeNull();
    expect(j["verifiedPublisher"]).toBeNull();
    expect(j["license"]).toBe("MIT");
  });

  test("a package clone cannot inspect does not create --into", async () => {
    const s = await stage(baseManifest("acme/tool"));
    // Overwrite the archive with junk and point the sha at the junk, so only inspect fails.
    writeFileSync(s.archivePath, "not a tarball");
    const sha = createHash("sha256").update("not a tarball").digest("hex");
    const h = harness({ reply: reply(s, { packageSha256: sha }) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(existsSync(join(cwd, "tool"))).toBe(false);
    expect(existsSync(s.archivePath)).toBe(false);
  });

  test("a failure after --into was created removes it", async () => {
    // The same file listed twice: inspect accepts it, the second copy fails with EEXIST.
    const src = mkdtempSync(join(tmp, "dup-"));
    mkdirSync(join(src, "dist"));
    writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(baseManifest("acme/tool")));
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const archivePath = join(tmp, "data", "registry-clone-staging", "c-dup", "package.tgz");
    mkdirSync(join(archivePath, ".."), { recursive: true });
    await tarCreate({ gzip: true, file: archivePath, cwd: src, portable: true }, [
      "nimbus.extension.json",
      "dist/index.js",
      "dist/index.js",
    ]);
    const sha = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    const h = harness({ reply: reply({ archivePath, sha, stageDir: "" }) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain("could not write the copy");
    expect(existsSync(join(cwd, "tool"))).toBe(false);
  });

  test("a manifest naming another id is refused before --into is created", async () => {
    const s = await stage(baseManifest("evil/other"));
    const h = harness({ reply: reply(s) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain(
      "the package's manifest names evil/other, not acme/tool; nothing was written",
    );
    expect(existsSync(join(cwd, "tool"))).toBe(false);
  });

  test("an unreadable staged archive writes nothing", async () => {
    const archivePath = join(tmp, "data", "registry-clone-staging", "c-gone", "package.tgz");
    const h = harness({ reply: reply({ archivePath, sha: "0".repeat(64), stageDir: "" }) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain("the staged package could not be read; nothing was written");
    expect(existsSync(join(cwd, "tool"))).toBe(false);
  });

  test.each([
    ["not an object", "acme"],
    ["missing verifiedAt", { github: "acme" }],
    ["a non-string github", { github: 7, verifiedAt: "2026-10-01T00:00:00.000Z" }],
  ])("a verifiedPublisher that is %s reads as unverified", async (_label, vp) => {
    const s = await stage(baseManifest("acme/tool"));
    const h = harness({ reply: reply(s, { verifiedPublisher: vp }) });
    expect(await runExtensionClone(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).toContain(`(key ${FINGERPRINT}), Unverified publisher`);
  });
});

describe("isStrictlyInside", () => {
  const root = resolve(tmpdir(), "clone-root");

  test.each([
    ["the root itself", root, false],
    ["its parent", resolve(root, ".."), false],
    ["a sibling via ..", resolve(root, "../x"), false],
    ["a name starting with ..", join(root, "..foo"), true],
    ["a nested file", join(root, "a", "b.js"), true],
    ["an absolute path elsewhere", resolve(tmpdir(), "elsewhere", "x"), false],
  ])("%s", (_label, p, expected) => {
    expect(isStrictlyInside(root, p)).toBe(expected);
  });

  test("a different drive, and a case-only difference, take the platform's branch", () => {
    if (process.platform === "win32") {
      // path.relative across drives returns an absolute path: refused.
      expect(isStrictlyInside(String.raw`C:\r\root`, String.raw`D:\r\root\x`)).toBe(false);
      // Windows paths compare case-insensitively: the same directory.
      expect(isStrictlyInside(String.raw`C:\R\Root`, String.raw`c:\r\root\x`)).toBe(true);
    } else {
      // POSIX paths are case-sensitive: a case-only difference is another directory.
      expect(isStrictlyInside("/r/Root", "/r/root/x")).toBe(false);
    }
  });
});
