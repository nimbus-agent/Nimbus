import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../../automation/extension-store.ts";
import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { declaredNetworkFor } from "./declared-network.ts";

const ID = "com.example.decl";
let dir: string;
let db: Database;

/** An installed row whose manifest file exists and whose `manifest_hash` is those bytes' hash. */
function install(network: string[], opts: { hash?: string; file?: boolean } = {}): string {
  const installPath = join(dir, ID);
  mkdirSync(installPath, { recursive: true });
  const bytes = JSON.stringify({
    id: ID,
    version: "1.0.0",
    entry: "dist/index.js",
    permissions: { network, filesystem: { read: [], write: [] } },
  });
  if (opts.file !== false) writeFileSync(join(installPath, "nimbus.extension.json"), bytes);
  insertExtensionRow(db, {
    id: ID,
    version: "1.0.0",
    install_path: installPath,
    manifest_hash: opts.hash ?? createHash("sha256").update(bytes).digest("hex"),
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
  return installPath;
}

function grant(network: string[]): void {
  dbRun(
    db,
    `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, approved_at)
     VALUES (?, 'ext_com_example_decl', '1.0.0', 'd', ?, 1)`,
    [ID, JSON.stringify({ network, read: [], write: [] })],
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obs-declared-"));
  db = new Database(":memory:");
  dbRun(db, "PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 82);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("declaredNetworkFor", () => {
  test("reads the verified manifest, lowercased and deduped like a run grant", () => {
    install(["API.example.com", "api.example.com", "imap.example.com:993"]);
    grant(["api.example.com"]);
    expect(declaredNetworkFor(db, ID, "1.0.0")).toEqual({
      entries: ["api.example.com", "imap.example.com:993"],
      from: "manifest",
      approved: ["api.example.com"],
    });
  });

  test("a narrowed grant does not change what is declared", () => {
    install(["api.example.com", "imap.example.com:993"]);
    grant([]);
    const d = declaredNetworkFor(db, ID, "1.0.0");
    expect(d.entries).toEqual(["api.example.com", "imap.example.com:993"]);
    expect(d.approved).toEqual([]);
  });

  test("no grant: approved is undefined, declared still from the manifest", () => {
    install(["api.example.com"]);
    expect(declaredNetworkFor(db, ID, "1.0.0")).toEqual({
      entries: ["api.example.com"],
      from: "manifest",
      approved: undefined,
    });
  });

  test("a manifest whose bytes no longer match the installed hash falls back to the grant", () => {
    install(["api.example.com", "evil.example:443"], { hash: "0".repeat(64) });
    grant(["api.example.com"]);
    expect(declaredNetworkFor(db, ID, "1.0.0")).toEqual({
      entries: ["api.example.com"],
      from: "grant",
      approved: ["api.example.com"],
    });
  });

  test("a missing manifest falls back to the grant; with no grant either, nothing", () => {
    install(["api.example.com"], { file: false });
    expect(declaredNetworkFor(db, ID, "1.0.0")).toEqual({
      entries: [],
      from: "grant",
      approved: undefined,
    });
    grant(["api.example.com"]);
    expect(declaredNetworkFor(db, ID, "1.0.0").entries).toEqual(["api.example.com"]);
  });

  test("a version that is not the installed one never reads the installed manifest", () => {
    install(["api.example.com", "imap.example.com:993"]);
    grant(["api.example.com"]);
    expect(declaredNetworkFor(db, ID, "0.9.0")).toMatchObject({
      entries: ["api.example.com"],
      from: "grant",
    });
  });
});
