import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blake3HashFile, buildManifest, verifyManifest } from "./backup-manifest.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-backup-"));
  tempDirs.push(dir);
  return dir;
}

describe("backup manifest", () => {
  test("blake3HashFile returns 64-char hex", async () => {
    const dir = tmp();
    const p = join(dir, "x.bin");
    writeFileSync(p, "hello");
    expect(await blake3HashFile(p)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("buildManifest records per-file hashes and counts", async () => {
    const dir = tmp();
    const idxPath = join(dir, "index.db.gz");
    writeFileSync(idxPath, "FAKE");
    const m = await buildManifest({
      bundleDir: dir,
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      platform: "linux",
      contents: {
        index_rows: 5,
        vault_entries: 1,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      files: { "index.db.gz": idxPath },
      indexIncluded: true,
    });
    expect(m.hashes["index.db.gz"]).toMatch(/^[0-9a-f]{64}$/);
    expect(m.contents.index_rows).toBe(5);
    expect(m.contents.index_included).toBe(true);
  });

  test("buildManifest populates version=2 and schema_version when supplied", async () => {
    const dir = tmp();
    const p = join(dir, "test.bin");
    writeFileSync(p, "hello");
    const m = await buildManifest({
      bundleDir: dir,
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      platform: "linux",
      contents: {
        index_rows: 0,
        vault_entries: 1,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 1,
      },
      files: { "test.bin": p },
      indexIncluded: false,
    });
    expect(m.version).toBe(2);
    expect(m.schema_version).toBe(21);
  });

  test("verifyManifest accepts both version=1 (legacy) and version=2 (current) shapes", async () => {
    const dir = tmp();
    const p = join(dir, "x.bin");
    writeFileSync(p, "hello");
    const m1 = {
      version: 1 as const,
      nimbus_version: "0.0.9",
      created_at: "2026-01-01T00:00:00Z",
      platform: "linux" as const,
      contents: {
        index_rows: 0,
        index_included: false,
        vault_entries: 0,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      hashes: { "x.bin": await blake3HashFile(p) },
    };
    const r1 = await verifyManifest(m1, { "x.bin": p });
    expect(r1.ok).toBe(true);
  });

  test("verifyManifest rejects a tampered file", async () => {
    const dir = tmp();
    const p = join(dir, "f.bin");
    writeFileSync(p, "good");
    const m = await buildManifest({
      bundleDir: dir,
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      platform: "linux",
      contents: {
        index_rows: 0,
        vault_entries: 0,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      files: { "f.bin": p },
      indexIncluded: false,
    });
    writeFileSync(p, "tampered");
    const result = await verifyManifest(m, { "f.bin": p });
    expect(result.ok).toBe(false);
    expect(result.firstMismatch).toBe("f.bin");
  });

  test("verifyManifest returns ok:false with firstMismatch when a manifest file is missing from the files map", async () => {
    // Covers line 64: the true arm of `if (actualPath === undefined)`
    // The manifest lists "missing.bin" in hashes, but the files map does not contain that key.
    const dir = tmp();
    const p = join(dir, "present.bin");
    writeFileSync(p, "data");
    const presentHash = await blake3HashFile(p);
    const manifest: import("./backup-manifest.ts").BackupManifest = {
      version: 2,
      nimbus_version: "0.1.0",
      schema_version: 21,
      created_at: "2026-01-01T00:00:00Z",
      platform: "linux",
      contents: {
        index_rows: 0,
        index_included: false,
        vault_entries: 0,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      hashes: {
        "present.bin": presentHash,
        "missing.bin": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    };
    // files map intentionally omits "missing.bin"
    const result = await verifyManifest(manifest, { "present.bin": p });
    expect(result.ok).toBe(false);
    expect(result.firstMismatch).toBe("missing.bin");
  });

  test("verifyManifest returns ok:true when all hashes match (v2 manifest)", async () => {
    // Happy path: every key in hashes is present in files and content matches
    const dir = tmp();
    const p1 = join(dir, "a.bin");
    const p2 = join(dir, "b.bin");
    writeFileSync(p1, "content-a");
    writeFileSync(p2, "content-b");
    const m = await buildManifest({
      bundleDir: dir,
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      platform: "linux",
      contents: {
        index_rows: 2,
        vault_entries: 0,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      files: { "a.bin": p1, "b.bin": p2 },
      indexIncluded: false,
    });
    const result = await verifyManifest(m, { "a.bin": p1, "b.bin": p2 });
    expect(result.ok).toBe(true);
    expect(result.firstMismatch).toBeUndefined();
  });

  test("verifyManifest returns ok:true for an empty hashes record", async () => {
    // Edge case: manifest with no files — loop body never executes, returns {ok:true}
    const manifest: import("./backup-manifest.ts").BackupManifest = {
      version: 2,
      nimbus_version: "0.1.0",
      schema_version: 21,
      created_at: "2026-01-01T00:00:00Z",
      platform: "linux",
      contents: {
        index_rows: 0,
        index_included: false,
        vault_entries: 0,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      hashes: {},
    };
    const result = await verifyManifest(manifest, {});
    expect(result.ok).toBe(true);
  });
});
