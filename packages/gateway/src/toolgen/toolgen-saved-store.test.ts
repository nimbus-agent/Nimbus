import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { signArtifact } from "./toolgen-keypair.ts";
import {
  listSavedToolDirs,
  parseCanonicalArtifact,
  readVerifiedSavedTool,
  removeSavedTool,
  rewriteSavedToolScript,
  savedToolDir,
  writeSavedTool,
} from "./toolgen-saved-store.ts";

/** Minimal in-memory `NimbusVault` fake — no real Vault/OS keychain involved. */
class FakeVault implements NimbusVault {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => !prefix || k.startsWith(prefix));
  }
}

function cfg(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-toolgen-saved-"));
}

const VALID_FIELDS = {
  toolId: "t1",
  toolName: "gitea_open_prs",
  description: "List open PRs",
  body: "export async function run() { return 1; }",
  approvedHosts: ["api.example.com"],
  credentialHosts: [],
  inputSchema: { type: "object", properties: {} },
  manifest: {
    id: "toolgen.t1",
    version: "0.0.0",
    updateChannel: "stable",
    network: [],
    filesystemWrite: [],
  },
};

const CANON = JSON.stringify(VALID_FIELDS);

describe("writeSavedTool / readVerifiedSavedTool", () => {
  test("write then read verifies", async () => {
    const dir = cfg();
    const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    const r = await readVerifiedSavedTool(dir, "t1", pubkeyB64);
    expect(r).toMatchObject({ ok: true, canonicalJson: CANON });
  });

  test("writeSavedTool creates all three files", async () => {
    // Ordering (artifact.sig written LAST) is a crash-safety property, not one this test can
    // observe without fault injection or a writeFile spy — it only confirms the end state.
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    const toolDir = savedToolDir(dir, "t1");
    expect(existsSync(join(toolDir, "index.ts"))).toBe(true);
    expect(existsSync(join(toolDir, "artifact.json"))).toBe(true);
    expect(existsSync(join(toolDir, "artifact.sig"))).toBe(true);
  });

  // ACLs are asserted by the Windows integration leg, so this one is SKIPPED there rather than
  // returning early — an early return reports a pass for a test that made no assertion.
  test.skipIf(process.platform === "win32")("written files are owner-only on POSIX", async () => {
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    const toolDir = savedToolDir(dir, "t1");
    expect(statSync(toolDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(toolDir, "artifact.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(toolDir, "artifact.sig")).mode & 0o777).toBe(0o600);
  });

  test("a tampered artifact.json is refused", async () => {
    const dir = cfg();
    const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    writeFileSync(join(savedToolDir(dir, "t1"), "artifact.json"), `${CANON} `);
    expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("a missing artifact.sig is refused as signature_missing, distinct from a mismatch", async () => {
    const dir = cfg();
    const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    await rm(join(savedToolDir(dir, "t1"), "artifact.sig"));
    expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({
      ok: false,
      reason: "signature_missing",
    });
  });

  test("a missing artifact.json is refused as artifact_missing", async () => {
    const dir = cfg();
    const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    await rm(join(savedToolDir(dir, "t1"), "artifact.json"));
    expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({
      ok: false,
      reason: "artifact_missing",
    });
  });

  test("a missing directory altogether is refused as artifact_missing", async () => {
    const dir = cfg();
    const { pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
    expect(await readVerifiedSavedTool(dir, "never-saved", pubkeyB64)).toEqual({
      ok: false,
      reason: "artifact_missing",
    });
  });

  test("a signature made by a different key is refused as signature_mismatch, not pubkey_rotated", async () => {
    // The store cannot tell a rotation from tampering; both are "verify returned false". Task 8
    // owns that distinction because only the caller knows whether the ROW's stored pubkey differs
    // from the Vault's current one.
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    const other = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    expect(await readVerifiedSavedTool(dir, "t1", other.pubkeyB64)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("a tampered index.ts does NOT affect verification — it is derived, not signed", async () => {
    const dir = cfg();
    const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    writeFileSync(join(savedToolDir(dir, "t1"), "index.ts"), "malicious()");
    expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toMatchObject({
      ok: true,
      canonicalJson: CANON,
    });
  });

  test("a VALIDLY SIGNED artifact with the wrong shape is refused as schema_invalid", async () => {
    // The signature verifies — this is a real artifact from a different build, not an attack.
    // Verification proves the bytes were not altered; it says nothing about their shape.
    const dir = cfg();
    const wrongShape = JSON.stringify({ toolId: "t1", body: "x" }); // no approvedHosts, no manifest
    const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), wrongShape);
    await writeSavedTool(dir, "t1", { canonicalJson: wrongShape, sigB64, script: "//" });
    expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({
      ok: false,
      reason: "schema_invalid",
    });
  });
});

describe("parseCanonicalArtifact", () => {
  test("POSITIVE CONTROL — accepts a well-formed artifact", () => {
    expect(parseCanonicalArtifact(CANON)).not.toBeNull();
  });

  test("rejects a wrong-typed field rather than coercing it (string where an array belongs)", () => {
    expect(
      parseCanonicalArtifact(JSON.stringify({ ...VALID_FIELDS, approvedHosts: "api.example.com" })),
    ).toBeNull();
  });

  test("rejects a wrong-typed field rather than coercing it (number where a string belongs)", () => {
    expect(parseCanonicalArtifact(JSON.stringify({ ...VALID_FIELDS, body: 42 }))).toBeNull();
  });

  test("rejects a wrong-typed field inside the nested manifest (array where a string belongs)", () => {
    expect(
      parseCanonicalArtifact(
        JSON.stringify({ ...VALID_FIELDS, manifest: { ...VALID_FIELDS.manifest, id: [1, 2] } }),
      ),
    ).toBeNull();
  });

  test("rejects a manifest whose network grant is non-empty-typed but wrong (a string, not an array)", () => {
    expect(
      parseCanonicalArtifact(
        JSON.stringify({
          ...VALID_FIELDS,
          manifest: { ...VALID_FIELDS.manifest, network: "not-an-array" },
        }),
      ),
    ).toBeNull();
  });

  test("rejects malformed JSON", () => {
    expect(parseCanonicalArtifact("{ not json")).toBeNull();
  });

  test("rejects a JSON array at the top level", () => {
    expect(parseCanonicalArtifact("[]")).toBeNull();
  });

  test("rejects a missing field", () => {
    const { manifest, ...rest } = VALID_FIELDS;
    expect(parseCanonicalArtifact(JSON.stringify(rest))).toBeNull();
  });

  test("rejects null where the manifest object belongs", () => {
    expect(parseCanonicalArtifact(JSON.stringify({ ...VALID_FIELDS, manifest: null }))).toBeNull();
  });
});

describe("removeSavedTool", () => {
  test("drops the tool directory", async () => {
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
    await removeSavedTool(dir, "t1");
    expect(existsSync(savedToolDir(dir, "t1"))).toBe(false);
  });

  test("is idempotent — removing twice does not throw", async () => {
    const dir = cfg();
    await removeSavedTool(dir, "t1");
    await expect(removeSavedTool(dir, "t1")).resolves.toBeUndefined();
  });
});

describe("listSavedToolDirs", () => {
  test("returns directory names only, for the orphan sweep", async () => {
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "//" });
    await writeSavedTool(dir, "t2", { canonicalJson: CANON, sigB64, script: "//" });
    const names = (await listSavedToolDirs(dir)).sort();
    expect(names).toEqual(["t1", "t2"]);
  });

  test("returns an empty array when nothing has ever been saved", async () => {
    const dir = cfg();
    expect(await listSavedToolDirs(dir)).toEqual([]);
  });

  test("excludes a non-directory entry sitting in saved/ (e.g. a stray .DS_Store)", async () => {
    // macOS Finder drops a .DS_Store into any directory it has viewed. Task 8's orphan sweep feeds
    // every returned name straight into removeSavedTool -> assertSafeToolId, whose regex
    // (^[A-Za-z0-9_-]{1,64}$) rejects a dot and throws — so a file here must never be reported as
    // a tool id. This test fails against a plain `readdir(dir)` call, which returns file names
    // indiscriminately.
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "//" });
    writeFileSync(join(savedToolDir(dir, "t1"), "..", ".DS_Store"), "");
    expect(await listSavedToolDirs(dir)).toEqual(["t1"]);
  });
});

describe("rewriteSavedToolScript", () => {
  test("re-emits index.ts and returns its path", async () => {
    const dir = cfg();
    const { sigB64 } = await signArtifact(new FakeVault(), CANON);
    await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// old" });
    const p = await rewriteSavedToolScript(dir, "t1", "// new");
    expect(p).toBe(join(savedToolDir(dir, "t1"), "index.ts"));
    expect(await readFile(p, "utf8")).toBe("// new");
  });
});

describe("unsafe tool ids", () => {
  test("writeSavedTool refuses an unsafe id before touching the filesystem", async () => {
    const dir = cfg();
    await expect(
      writeSavedTool(dir, "../escape", { canonicalJson: CANON, sigB64: "s", script: "" }),
    ).rejects.toThrow();
    // Nothing should have been created one level up from the temp dir.
    expect(existsSync(join(dir, "..", "escape"))).toBe(false);
  });

  test("readVerifiedSavedTool refuses an unsafe id before touching the filesystem", async () => {
    await expect(readVerifiedSavedTool(cfg(), "a/b", "pk")).rejects.toThrow();
  });

  test("savedToolDir refuses a path-traversal id", () => {
    expect(() => savedToolDir(cfg(), "../../etc")).toThrow();
  });
});

// Sanity: read `readFileSync` from the actual store layout to make sure `artifact.sig` is stored
// verbatim (no trailing newline injected), since the whole design rests on verifying the EXACT
// bytes that were signed.
test("artifact.sig round-trips the signature verbatim, no injected newline", async () => {
  const dir = cfg();
  const { sigB64 } = await signArtifact(new FakeVault(), CANON);
  await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "//" });
  expect(readFileSync(join(savedToolDir(dir, "t1"), "artifact.sig"), "utf8")).toBe(sigB64);
});
