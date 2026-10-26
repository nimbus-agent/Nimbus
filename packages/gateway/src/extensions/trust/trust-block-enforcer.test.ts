import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  type UnsignedTrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { insertExtensionRow } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { upsertRunGrant } from "../run-grant-store.ts";
import { createTrustBlockEnforcer, notificationBody } from "./trust-block-enforcer.ts";
import type { TrustBlock } from "./trust-blocks.ts";
import { recordTrustStatements } from "./trust-store.ts";

const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 9);
const NIMBUS_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);
const PUB_KEY = encodeBase64(new Uint8Array(32).fill(3));

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 76);
  dir = mkdtempSync(join(tmpdir(), "nimbus-trust-enforcer-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An installed, publisher-signed row whose manifest passes the hash check. */
function installed(id: string, enabled = 1): void {
  const p = join(dir, id);
  mkdirSync(p, { recursive: true });
  const manifest = JSON.stringify({
    id,
    version: "1.0.0",
    permissions: {},
    publisher: { id: "acme", key: PUB_KEY },
    signature: `${"A".repeat(86)}==`,
  });
  writeFileSync(join(p, "nimbus.extension.json"), manifest);
  insertExtensionRow(db, {
    id,
    version: "1.0.0",
    install_path: p,
    manifest_hash: createHash("sha256").update(manifest).digest("hex"),
    entry_hash: "e",
    enabled,
    installed_at: 1,
    last_verified_at: 1,
  });
}

async function record(statement: UnsignedTrustStatement): Promise<string[]> {
  const s = await signTrustStatement(statement, NIMBUS_SEED);
  return recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: NIMBUS_KEY }, 1).insertedIds;
}

const takedown = (extensionId: string, reason = "malware") =>
  record({
    kind: "extension.takedown",
    issuedAt: "2026-10-26T12:00:00Z",
    signerKey: NIMBUS_KEY,
    extensionId,
    publisherId: "acme",
    versions: "*",
    reason,
  });

function harness(stopFails = false) {
  const stopped: string[] = [];
  const notes: Array<[string, string]> = [];
  const warns: string[] = [];
  const enforcer = createTrustBlockEnforcer({
    db,
    stop: async (id) => {
      stopped.push(id);
      if (stopFails) throw new Error("stop failed");
    },
    notify: (t, b) => void notes.push([t, b]),
    logger: { warn: (_o: unknown, m: string) => void warns.push(m) } as never,
  });
  return { enforcer, stopped, notes, warns };
}

describe("createTrustBlockEnforcer", () => {
  test("a newly recorded block stops the extension and notifies once", async () => {
    installed("acme.a");
    installed("acme.b");
    const h = harness();
    await h.enforcer.onRecorded(await takedown("acme.a", "found malware"));
    expect(h.stopped).toEqual(["acme.a"]);
    expect(h.notes).toEqual([
      [
        "Extension blocked",
        "acme.a: it was taken down by Nimbus (found malware). It will not run until you re-approve it.",
      ],
    ]);
  });

  test("ids that were not newly inserted, or block nothing installed, do nothing", async () => {
    installed("acme.a");
    const h = harness();
    await h.enforcer.onRecorded([]);
    await h.enforcer.onRecorded(await takedown("acme.other"));
    await h.enforcer.onRecorded(["not-a-stored-id"]);
    expect(h.stopped).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  test("a revocation of the extension's key reaches it; one notification per extension", async () => {
    installed("acme.a");
    const ids = [
      ...(await record({
        kind: "key.revoke",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: NIMBUS_KEY,
        publisherId: "acme",
        keyFingerprint: publisherKeyFingerprint(PUB_KEY),
        reason: "leaked",
      })),
      ...(await takedown("acme.a")),
    ];
    const h = harness();
    await h.enforcer.onRecorded(ids);
    expect(h.stopped).toEqual(["acme.a"]);
    expect(h.notes).toHaveLength(1);
  });

  test("a block the run grant already acknowledged, or a disabled extension, is left alone", async () => {
    installed("acme.a");
    installed("acme.off", 0);
    const ids = [...(await takedown("acme.a")), ...(await takedown("acme.off"))];
    upsertRunGrant(db, {
      extension_id: "acme.a",
      service_id: "ext_acme_a",
      version: "1.0.0",
      tree_digest: "d".repeat(64),
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
      trust_ack_json: JSON.stringify(ids),
    });
    const h = harness();
    await h.enforcer.onRecorded(ids);
    expect(h.stopped).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  test("a failing stop is logged and the owner is still told", async () => {
    installed("acme.a");
    const h = harness(true);
    await h.enforcer.onRecorded(await takedown("acme.a"));
    expect(h.warns).toEqual(["could not stop a blocked extension"]);
    expect(h.notes).toHaveLength(1);
  });

  test("an unreadable manifest is skipped; a database that cannot be read is logged", async () => {
    installed("acme.a");
    writeFileSync(join(dir, "acme.a", "nimbus.extension.json"), "{}");
    const h = harness();
    await h.enforcer.onRecorded(await takedown("acme.a"));
    expect(h.notes).toEqual([]);
    db.close(); // the enforcer holds this handle; every read on it now throws
    db = new Database(":memory:"); // afterEach closes this one
    await h.enforcer.onRecorded(["x"]);
    expect(h.warns).toEqual(["trust block enforcement could not list extensions"]);
  });
});

describe("notificationBody", () => {
  const block = (over: Partial<TrustBlock>): TrustBlock => ({
    statementId: "s",
    kind: "key.revoke",
    issuer: "publisher",
    registry: null,
    reason: "r",
    issuedAt: "2026-10-26T12:00:00Z",
    ...over,
  });
  test("names what happened and who did it, for every issuer", () => {
    expect(notificationBody("a", block({}))).toBe(
      "a: its publisher key was revoked by its publisher (r). It will not run until you re-approve it.",
    );
    expect(notificationBody("a", block({ issuer: "registry", registry: "community" }))).toContain(
      'by the maintainer of registry "community"',
    );
    expect(notificationBody("a", block({ issuer: "registry", registry: null }))).toContain(
      'registry "?"',
    );
    expect(
      notificationBody("a", block({ kind: "extension.takedown", issuer: "nimbus" })),
    ).toContain("it was taken down by Nimbus");
  });
});
