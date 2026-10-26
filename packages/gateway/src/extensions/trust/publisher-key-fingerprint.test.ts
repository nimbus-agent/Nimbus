import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import { listExtensions } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { MockVault } from "../../vault/mock.ts";
import { writePublisherKey } from "../publisher-keys.ts";
import { backfillPublisherKeyFingerprints } from "./publisher-key-fingerprint.ts";

let db: Database;
let root: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 76);
  root = mkdtempSync(join(tmpdir(), "nimbus-keyfp-"));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addRow(id: string, manifest: Record<string, unknown> | null, fp: string | null = null) {
  const dir = join(root, id.replaceAll("/", "_"));
  mkdirSync(dir, { recursive: true });
  if (manifest !== null)
    writeFileSync(join(dir, "nimbus.extension.json"), JSON.stringify(manifest));
  db.run(
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, publisher_key_fingerprint)
     VALUES (?, '1.0.0', ?, 'm', 'e', 1, 1, 1, ?)`,
    [id, dir, fp],
  );
}

const fpOf = (id: string) => listExtensions(db).find((r) => r.id === id)?.publisher_key_fingerprint;
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
// The backfill reads the manifest only for its publisher id; it never verifies this signature.
const SIG = `${"A".repeat(86)}==`;

describe("backfillPublisherKeyFingerprints", () => {
  test("fills a signed row from the Vault, leaves unsigned and already-set rows alone", async () => {
    const vault = new MockVault();
    await writePublisherKey(vault, "acme", KEY);
    addRow("acme/a", {
      id: "acme/a",
      version: "1.0.0",
      publisher: { id: "acme", key: encodeBase64(KEY) },
      signature: SIG,
      permissions: {},
    });
    addRow("plain", { id: "plain", version: "1.0.0", permissions: {} });
    addRow(
      "acme/b",
      {
        id: "acme/b",
        version: "1.0.0",
        publisher: { id: "acme", key: encodeBase64(KEY) },
        signature: SIG,
        permissions: {},
      },
      "already",
    );
    expect(await backfillPublisherKeyFingerprints(db, vault)).toBe(1);
    expect(fpOf("acme/a")).toBe(publisherKeyFingerprint(encodeBase64(KEY)));
    expect(fpOf("plain")).toBeNull();
    expect(fpOf("acme/b")).toBe("already");
  });

  test("a row whose manifest is missing or whose key is not in the Vault stays NULL", async () => {
    const vault = new MockVault();
    addRow("gone", null);
    addRow("nokey", {
      id: "nokey",
      version: "1.0.0",
      publisher: { id: "ghost", key: encodeBase64(KEY) },
      signature: SIG,
      permissions: {},
    });
    expect(await backfillPublisherKeyFingerprints(db, vault)).toBe(0);
    expect(fpOf("gone")).toBeNull();
    expect(fpOf("nokey")).toBeNull();
  });

  test("a Vault error on one row does not stop the others", async () => {
    const vault = new MockVault();
    await writePublisherKey(vault, "acme", KEY);
    const flaky = {
      ...vault,
      get: async (k: string) => {
        if (k.endsWith(".broken")) throw new Error("vault locked");
        return vault.get(k);
      },
    } as unknown as MockVault;
    addRow("b/1", {
      id: "b/1",
      version: "1.0.0",
      publisher: { id: "broken", key: encodeBase64(KEY) },
      signature: SIG,
      permissions: {},
    });
    addRow("acme/a", {
      id: "acme/a",
      version: "1.0.0",
      publisher: { id: "acme", key: encodeBase64(KEY) },
      signature: SIG,
      permissions: {},
    });
    expect(await backfillPublisherKeyFingerprints(db, flaky)).toBe(1);
    expect(fpOf("b/1")).toBeNull();
  });
});
