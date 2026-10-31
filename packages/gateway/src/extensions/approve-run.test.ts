import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  trustStatementId,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import {
  installStarterPackFixture,
  PACK_FIXTURE,
  TOP_PACK_REFUSAL,
} from "../../test/helpers/starter-pack-fixture.ts";
import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import {
  insertExtensionRow,
  listExtensions,
  setExtensionTreeDigest,
} from "../automation/extension-store.ts";
import { redactPayloadForConsentDisplay } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import {
  approveExtensionRun,
  approveMigratedExtensionRun,
  buildRunConsentPayload,
  currentRunCredentials,
  readVerifiedManifest,
  revokeExtensionRun,
} from "./approve-run.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import { serializeRunCredentials } from "./extension-credentials.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { installExtensionFromLocalDirectory } from "./install-from-local.ts";
import { recordMigrationPrepared } from "./migration/migration-store.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { deleteRunGrant, getRunGrant, listRunGrants, upsertRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { recordTrustStatements, type StatementSource } from "./trust/trust-store.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

type Asked = { type: string; payload: Record<string, unknown> };

/**
 * Installs a real extension into a fresh temp root. `<root>/outside` and `<root>/data` exist before
 * the manifest is written, so `manifest(root)` can declare grants naming them.
 */
async function setup(
  opts: {
    id?: string;
    manifest?: (root: string) => Record<string, unknown>;
    signed?: boolean;
  } = {},
): Promise<{
  db: Database;
  root: string;
  installPath: string;
  env: ExtensionRunGrantEnv;
  publisherKey?: string;
}> {
  const id = opts.id ?? "com.example.run";
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-approve-run-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  mkdirSync(join(root, "outside"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  const manifest: Record<string, unknown> = {
    id,
    version: "1.0.0",
    entry: "dist/index.js",
    ...(opts.manifest?.(root) ?? {}),
  };
  let publisherKey: string | undefined;
  let publisherKeyPath: string | undefined;
  if (opts.signed === true) {
    const kp = generateEd25519Keypair();
    publisherKey = encodeBase64(kp.pubkey);
    manifest["publisher"] = { id: "test-pub", key: publisherKey };
    manifest["signature"] = await signManifest(manifest, kp.privkey);
    publisherKeyPath = join(root, "pub.key");
    writeFileSync(publisherKeyPath, `${publisherKey}\n`);
  }
  writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  const extensionsDir = join(root, "data", "extensions");
  await installExtensionFromLocalDirectory({
    db,
    extensionsDir,
    sourcePath: src,
    approve: async () => true,
    ...(publisherKeyPath === undefined ? {} : { vault: new MockVault(), publisherKeyPath }),
  });
  const env: ExtensionRunGrantEnv = {
    platform: process.platform,
    protectedRoots: [join(root, "data"), join(root, "config")],
    runtimeReadPaths: [join(root, "bun-bin")],
    realpath: (p) => realpathSync.native(p),
  };
  return {
    db,
    root,
    installPath: join(extensionsDir, id),
    env,
    ...(publisherKey === undefined ? {} : { publisherKey }),
  };
}

const gateThat = (answer: boolean, seen: Asked[]) => async (a: Asked) => {
  seen.push(a);
  return answer;
};

describe("approveExtensionRun", () => {
  test("[extensions] runtime = false refuses ERR_EXTENSION_RUNTIME_DISABLED before the gate", async () => {
    const { db, env } = await setup();
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: gateThat(true, seen),
        runtimeEnabled: false,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUNTIME_DISABLED/);
    expect(seen).toHaveLength(0);
    expect(listRunGrants(db)).toEqual([]);
  });

  test("asks once as extension.run over the resolved grants, then stores exactly that", async () => {
    const s = await setup({
      id: "com.example.perm",
      manifest: (root) => ({
        permissions: {
          network: ["API.example.com"],
          filesystem: { read: [join(root, "outside")], write: [] },
        },
      }),
    });
    const outside = join(s.root, "outside");
    const seen: Asked[] = [];
    const out = await approveExtensionRun("com.example.perm", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 42,
    });
    expect(seen.map((a) => a.type)).toEqual(["extension.run"]);
    const p = seen[0]?.payload ?? {};
    expect(p["serviceId"]).toBe("ext_com_example_perm");
    expect(p["publisher"]).toBe("unsigned");
    expect(p["network"]).toEqual(["api.example.com"]);
    expect(p["read"]).toEqual([outside]);
    expect(p["runtimeRead"]).toEqual([...s.env.runtimeReadPaths]);
    expect(p["runtimeRead"]).not.toContain(s.installPath);
    expect(p["runsFrom"]).toBe(
      `a verified per-spawn copy of ${s.installPath}, in the extension's own writable working directory`,
    );
    // No field name the consent redactor would hide (any name containing "key").
    expect(Object.keys(p).filter((k) => /key/i.test(k))).toEqual([]);
    expect(p["modelAccess"]).toBe(false);
    expect(out).toMatchObject({ serviceId: "ext_com_example_perm", changed: true });
    expect(getRunGrant(s.db, "com.example.perm")).toEqual({
      extension_id: "com.example.perm",
      service_id: "ext_com_example_perm",
      version: "1.0.0",
      tree_digest: computeExtensionTreeDigest(s.installPath),
      permissions_json: JSON.stringify({
        network: ["api.example.com"],
        read: [outside],
        write: [],
      }),
      model_access: 0,
      approved_at: 42,
      credentials_json: "{}",
      trust_ack_json: "[]",
    });
  });

  test("a denial stores nothing", async () => {
    const { db, env } = await setup();
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: gateThat(false, []),
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_APPROVED/);
    expect(listRunGrants(db)).toEqual([]);
  });

  test("an unchanged re-approval answers without prompting", async () => {
    const { db, env } = await setup();
    await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, []),
      runtimeEnabled: true,
      now: () => 1,
    });
    const seen: Asked[] = [];
    const out = await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 2,
    });
    expect(out.changed).toBe(false);
    expect(seen).toEqual([]);
    expect(getRunGrant(db, "com.example.run")?.approved_at).toBe(1);
  });

  const approveWith = (
    s: { db: Database; env: ExtensionRunGrantEnv },
    seen: Asked[],
    modelAccess?: boolean,
  ) =>
    approveExtensionRun("com.example.run", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 1,
      ...(modelAccess === undefined ? {} : { modelAccess }),
    });

  test("--model writes model_access = 1 and the prompt shows modelAccess: true", async () => {
    const s = await setup();
    const seen: Asked[] = [];
    const out = await approveWith(s, seen, true);
    expect(seen[0]?.payload["modelAccess"]).toBe(true);
    expect(out.modelAccess).toBe(true);
    expect(getRunGrant(s.db, "com.example.run")?.model_access).toBe(1);
  });

  test("no flag writes model_access = 0", async () => {
    const s = await setup();
    const out = await approveWith(s, []);
    expect(out.modelAccess).toBe(false);
    expect(getRunGrant(s.db, "com.example.run")?.model_access).toBe(0);
  });

  test("a change only in model access prompts and writes (not short-circuited)", async () => {
    const s = await setup();
    const seen: Asked[] = [];
    await approveWith(s, seen);
    const on = await approveWith(s, seen, true);
    expect(seen).toHaveLength(2);
    expect(on.changed).toBe(true);
    expect(getRunGrant(s.db, "com.example.run")?.model_access).toBe(1);
    const off = await approveWith(s, seen);
    expect(seen).toHaveLength(3);
    expect(off.changed).toBe(true);
    expect(getRunGrant(s.db, "com.example.run")?.model_access).toBe(0);
  });

  test("an identical re-approval including model access short-circuits", async () => {
    const s = await setup();
    const seen: Asked[] = [];
    await approveWith(s, seen, true);
    const again = await approveWith(s, seen, true);
    expect(seen).toHaveLength(1);
    expect(again.changed).toBe(false);
    expect(again.modelAccess).toBe(true);
  });

  test("Review Focus 4: files changing during the prompt refuse and store nothing", async () => {
    const { db, env, installPath } = await setup();
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: async () => {
          writeFileSync(join(installPath, "dist", "late.js"), "export const x = 1;\n");
          return true;
        },
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
    expect(listRunGrants(db)).toEqual([]);
  });

  // Each of these changes the ROW while the prompt is open and leaves the files alone, so only the
  // matching arm of the post-approval re-check can refuse it.
  test.each([
    ["disabled during the prompt", "UPDATE extension SET enabled = 0 WHERE id = 'com.example.run'"],
    ["row deleted during the prompt", "DELETE FROM extension WHERE id = 'com.example.run'"],
    [
      "version changed during the prompt",
      "UPDATE extension SET version = '9.9.9' WHERE id = 'com.example.run'",
    ],
    [
      "only the stored digest changed during the prompt",
      `UPDATE extension SET tree_digest = '${"f".repeat(64)}' WHERE id = 'com.example.run'`,
    ],
  ])("%s refuses and stores nothing", async (_name, sql) => {
    const { db, env } = await setup();
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: async () => {
          db.run(sql);
          return true;
        },
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
    expect(listRunGrants(db)).toEqual([]);
  });

  test("the install path moving during the prompt refuses, even to an identical copy", async () => {
    const { db, env, root, installPath } = await setup();
    const moved = join(root, "moved");
    cpSync(installPath, moved, { recursive: true });
    // Premise: the copy hashes the same, so only the install_path arm can refuse this.
    expect(computeExtensionTreeDigest(moved)).toBe(computeExtensionTreeDigest(installPath));
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: async () => {
          db.run("UPDATE extension SET install_path = ? WHERE id = 'com.example.run'", [moved]);
          return true;
        },
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
    expect(listRunGrants(db)).toEqual([]);
  });

  test("a rewritten entry file refuses BEFORE prompting, even with the tree re-adopted", async () => {
    const { db, env, installPath } = await setup();
    writeFileSync(join(installPath, "dist", "index.js"), "export const evil = 1;\n");
    // Re-adopt the tree so the tree-digest check passes; only the strict manifest/entry check is left.
    setExtensionTreeDigest(db, "com.example.run", computeExtensionTreeDigest(installPath));
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_UNVERIFIED/);
    expect(seen).toEqual([]);
  });

  test("Review Focus 5: after the code changes and is re-adopted, approving again prompts, replaces the grant and keeps the service id", async () => {
    const { db, env, installPath } = await setup();
    await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, []),
      runtimeEnabled: true,
      now: () => 1,
    });
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    setExtensionTreeDigest(db, "com.example.run", computeExtensionTreeDigest(installPath));
    const seen: Asked[] = [];
    const out = await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 2,
    });
    expect(seen).toHaveLength(1);
    expect(out.changed).toBe(true);
    expect(getRunGrant(db, "com.example.run")).toMatchObject({
      service_id: "ext_com_example_run",
      tree_digest: computeExtensionTreeDigest(installPath),
      approved_at: 2,
    });
  });

  test("files changed since install refuse BEFORE prompting", async () => {
    const { db, env, installPath } = await setup();
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_TREE_CHANGED/);
    expect(seen).toEqual([]);
  });

  test("a protected grant refuses BEFORE prompting", async () => {
    const { db, env } = await setup({
      manifest: (root) => ({
        permissions: { network: [], filesystem: { read: [join(root, "data")], write: [] } },
      }),
    });
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("com.example.run", {
        db,
        env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_GRANT_PROTECTED/);
    expect(seen).toEqual([]);
  });

  test("a disabled extension, an unknown one, and one with no digest refuse before prompting", async () => {
    const { db, env } = await setup();
    const seen: Asked[] = [];
    const run = (id: string) =>
      approveExtensionRun(id, {
        db,
        env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      });
    await expect(run("nope")).rejects.toThrow(/ERR_EXTENSION_NOT_FOUND/);
    db.run("UPDATE extension SET tree_digest = NULL WHERE id = 'com.example.run'");
    await expect(run("com.example.run")).rejects.toThrow(/ERR_EXTENSION_RUN_NO_DIGEST/);
    db.run("UPDATE extension SET enabled = 0 WHERE id = 'com.example.run'");
    await expect(run("com.example.run")).rejects.toThrow(/ERR_EXTENSION_RUN_DISABLED/);
    expect(seen).toEqual([]);
  });

  test("a new grant whose service id collides with another extension's refuses before prompting", async () => {
    const { db, env } = await setup({ id: "a.b" });
    // Foreign keys are ON: the colliding grant needs a real `extension` row to belong to, so this
    // exercises the service-id collision rather than the FK.
    insertExtensionRow(db, {
      id: "other",
      version: "1",
      install_path: "/other",
      manifest_hash: "m",
      entry_hash: "e",
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
    upsertRunGrant(db, {
      extension_id: "other",
      service_id: "ext_a_b",
      version: "1",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    const seen: Asked[] = [];
    await expect(
      approveExtensionRun("a.b", {
        db,
        env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_SERVICE_ID_COLLISION/);
    expect(seen).toEqual([]);
  });

  test("the publisher fingerprint survives consent-display AND audit redaction", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const payload = buildRunConsentPayload(
      {
        row: {
          id: "p",
          version: "1.0.0",
          install_path: "/x",
          manifest_hash: "m",
          entry_hash: "e",
          enabled: 1,
          installed_at: 1,
          last_verified_at: 1,
          tree_digest: "d",
        },
        manifest: {
          id: "p",
          version: "1.0.0",
          updateChannel: "stable",
          permissions: { network: [], filesystem: { read: [], write: [] } },
          publisher: { id: "pub", key },
        },
        serviceId: "ext_p",
        treeDigest: "d",
        grants: { network: [], read: [], write: [] },
        modelAccess: false,
        credentials: {},
      },
      { platform: "linux", protectedRoots: [], runtimeReadPaths: [], realpath: (p) => p },
    );
    const fp = publisherKeyFingerprint(key);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    // Both redactors drop any field whose NAME contains "key"; `keyFingerprint` would vanish here.
    expect(JSON.stringify(redactPayloadForConsentDisplay(payload))).toContain(fp);
    expect(redactAuditPayload(payload, 4096)).toContain(fp);
  });

  test("the network line says on Windows that the host list is not enforced", () => {
    const payloadOn = (platform: NodeJS.Platform) =>
      buildRunConsentPayload(
        {
          row: {
            id: "n",
            version: "1.0.0",
            install_path: "/x",
            manifest_hash: "m",
            entry_hash: "e",
            enabled: 1,
            installed_at: 1,
            last_verified_at: 1,
            tree_digest: "d",
          },
          manifest: {
            id: "n",
            version: "1.0.0",
            updateChannel: "stable",
            permissions: { network: ["readwise.io"], filesystem: { read: [], write: [] } },
          },
          serviceId: "ext_n",
          treeDigest: "d",
          grants: { network: ["readwise.io"], read: [], write: [] },
          modelAccess: false,
          credentials: {},
        },
        { platform, protectedRoots: [], runtimeReadPaths: [], realpath: (p) => p },
      );
    const win = payloadOn("win32");
    expect(win["network"]).toEqual(["readwise.io"]);
    expect(win["networkAccess"]).toBe("network access (Windows cannot limit this to readwise.io)");
    expect(payloadOn("linux")["networkAccess"]).toBe("network access to readwise.io");
    expect(payloadOn("darwin")["networkAccess"]).toBe(
      "network access to any host on port 443 (macOS cannot limit this to readwise.io)",
    );
    // The consent display shows it: no redactor drops the field.
    expect(redactPayloadForConsentDisplay(win)).toMatchObject({
      networkAccess: "network access (Windows cannot limit this to readwise.io)",
    });
  });

  test("an extension the startup signature pass marked is refused while enabled", async () => {
    const { db, env } = await setup();
    signatureDisabledRegistry.mark("com.example.run", "signature_failed");
    try {
      const seen: Asked[] = [];
      await expect(
        approveExtensionRun("com.example.run", {
          db,
          env,
          gate: gateThat(true, seen),
          runtimeEnabled: true,
          now: () => 1,
        }),
      ).rejects.toThrow(/ERR_EXTENSION_RUN_UNVERIFIED.*signature_failed/);
      expect(seen).toEqual([]);
    } finally {
      signatureDisabledRegistry.reset();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a declared path retargeted into the data dir while the prompt is open refuses",
    async () => {
      const { db, env, root } = await setup({
        manifest: (r) => {
          symlinkSync(join(r, "outside"), join(r, "link"));
          return {
            permissions: { network: [], filesystem: { read: [join(r, "link")], write: [] } },
          };
        },
      });
      await expect(
        approveExtensionRun("com.example.run", {
          db,
          env,
          runtimeEnabled: true,
          now: () => 1,
          gate: async () => {
            // The install tree is untouched, so the tree digest alone would not notice this.
            unlinkSync(join(root, "link"));
            symlinkSync(join(root, "data"), join(root, "link"));
            return true;
          },
        }),
      ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
      expect(listRunGrants(db)).toEqual([]);
    },
  );
});

describe("state that changes while the prompt is open", () => {
  test("a colliding service id granted to another extension during the prompt refuses CHANGED and stores nothing for ours", async () => {
    const { db, env } = await setup({ id: "a.b" });
    await expect(
      approveExtensionRun("a.b", {
        db,
        env,
        gate: async () => {
          // A concurrent approval of `a.b.c` lands while ours is open; `ext_a_b_c` prefix-collides.
          insertExtensionRow(db, {
            id: "a.b.c",
            version: "1",
            install_path: "/other",
            manifest_hash: "m",
            entry_hash: "e",
            enabled: 1,
            installed_at: 1,
            last_verified_at: 1,
          });
          upsertRunGrant(db, {
            extension_id: "a.b.c",
            service_id: "ext_a_b_c",
            version: "1",
            tree_digest: "d",
            permissions_json: "{}",
            model_access: 0,
            approved_at: 1,
            credentials_json: "{}",
          });
          return true;
        },
        runtimeEnabled: true,
        now: () => 1,
      }),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_CHANGED/);
    expect(getRunGrant(db, "a.b")).toBeNull();
    expect(listRunGrants(db).map((g) => g.extension_id)).toEqual(["a.b.c"]);
  });
});

describe("credentials", () => {
  const credManifest =
    (extra: Record<string, unknown> = {}) =>
    () => ({
      credentials: { token: { env: "X_TOKEN" } },
      ...extra,
    });

  test("consent payload lists credential names and never a vault key", async () => {
    const s = await setup({ id: "com.example.cred", manifest: credManifest() });
    const seen: Asked[] = [];
    await approveExtensionRun("com.example.cred", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 1,
    });
    const p = seen[0]?.payload ?? {};
    expect(p["vaultEnv"]).toEqual([{ name: "token", env: "X_TOKEN" }]);
    const shown = JSON.stringify(p);
    expect(shown).not.toContain("ext.ext_com_example_cred.token");
    expect(shown).not.toContain("vaultKey");
    // It survives both redactors (a field NAMED "credentials" would be hidden by both).
    expect(JSON.stringify(redactPayloadForConsentDisplay(p))).toContain("X_TOKEN");
    expect(redactAuditPayload(p, 4096)).toContain("X_TOKEN");
    // No sync block, no sync sentence; not bound, so no reused connector.
    expect(p["sync"]).toBeUndefined();
    expect(p["reusesConnector"]).toBeUndefined();
  });

  test("grant row stores credentials_json (unbound: the extension's own key)", async () => {
    const s = await setup({ id: "com.example.cred", manifest: credManifest() });
    await approveExtensionRun("com.example.cred", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, []),
      runtimeEnabled: true,
      now: () => 1,
    });
    expect(getRunGrant(s.db, "com.example.cred")?.credentials_json).toBe(
      '{"token":{"env":"X_TOKEN","vaultKey":"ext.ext_com_example_cred.token"}}',
    );
  });

  test("a continuity binding stores the legacy vault key; a fingerprint mismatch does not bind", async () => {
    const s = await setup({ id: "com.example.cred", manifest: credManifest(), signed: true });
    s.db.run("UPDATE extension SET source_root_fingerprint = 'root-fp' WHERE id = ?", [
      "com.example.cred",
    ]);
    const entry: ContinuityEntry = {
      legacyServiceId: "readwise",
      extensionId: "com.example.cred",
      publisherKey: s.publisherKey ?? "",
      sourceRootFingerprint: "root-fp",
      credentials: { token: "readwise.token" },
      expectedPermissions: { network: [], read: [], write: [] },
      itemTypes: [],
    };
    const seen: Asked[] = [];
    await approveExtensionRun("com.example.cred", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 1,
      continuityTable: [entry],
    });
    expect(getRunGrant(s.db, "com.example.cred")?.credentials_json).toBe(
      '{"token":{"env":"X_TOKEN","vaultKey":"readwise.token"}}',
    );
    const bound = seen[0]?.payload ?? {};
    expect(JSON.stringify(bound)).not.toContain("readwise.token");
    // The owner is told the extension reuses the legacy connector's credential, and the disclosure
    // survives both redactors while naming no Vault key.
    expect(bound["reusesConnector"]).toBe("readwise");
    expect(redactPayloadForConsentDisplay(bound)).toMatchObject({ reusesConnector: "readwise" });
    expect(JSON.parse(redactAuditPayload(bound, 4096))).toMatchObject({
      reusesConnector: "readwise",
    });

    s.db.run("UPDATE extension SET source_root_fingerprint = 'other' WHERE id = ?", [
      "com.example.cred",
    ]);
    await approveExtensionRun("com.example.cred", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 2,
      continuityTable: [entry],
    });
    // The resolved credentials changed, so the owner is asked again — with no reuse disclosure.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.payload["reusesConnector"]).toBeUndefined();
    expect(getRunGrant(s.db, "com.example.cred")?.credentials_json).toBe(
      '{"token":{"env":"X_TOKEN","vaultKey":"ext.ext_com_example_cred.token"}}',
    );
  });

  test("a sync block adds the local-index sentence", async () => {
    const s = await setup({
      id: "com.example.sync",
      manifest: credManifest({
        sync: { contract: "1", intervalSeconds: 3600, itemTypes: ["highlight"] },
      }),
    });
    const seen: Asked[] = [];
    await approveExtensionRun("com.example.sync", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 1,
    });
    expect(seen[0]?.payload["sync"]).toBe(
      "this extension syncs into your local index (item types: highlight)",
    );
  });

  test("an unchanged re-approval with credentials short-circuits", async () => {
    const s = await setup({ id: "com.example.cred", manifest: credManifest() });
    const seen: Asked[] = [];
    const approve = () =>
      approveExtensionRun("com.example.cred", {
        db: s.db,
        env: s.env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      });
    await approve();
    expect((await approve()).changed).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe("readVerifiedManifest", () => {
  // `verifyOneExtensionStrict` already refuses a manifest whose bytes differ from the row's
  // `manifest_hash`, and it runs first — so through `approveExtensionRun` this check is unreachable
  // except in the window between the two reads. It is proven here, directly.
  test("refuses a manifest whose bytes differ from the row's manifest_hash", async () => {
    const { db } = await setup();
    const row = listExtensions(db).find((r) => r.id === "com.example.run");
    if (row === undefined) throw new Error("premise: the extension row exists");
    expect(readVerifiedManifest(row).id).toBe("com.example.run");
    expect(() => readVerifiedManifest({ ...row, manifest_hash: "0".repeat(64) })).toThrow(
      /ERR_EXTENSION_RUN_UNVERIFIED/,
    );
  });

  test("refuses when the manifest is rewritten after install", async () => {
    const { db, installPath } = await setup();
    const row = listExtensions(db).find((r) => r.id === "com.example.run");
    if (row === undefined) throw new Error("premise: the extension row exists");
    writeFileSync(
      join(installPath, "nimbus.extension.json"),
      JSON.stringify({ id: "com.example.run", version: "1.0.0", entry: "dist/index.js", x: 1 }),
    );
    expect(() => readVerifiedManifest(row)).toThrow(/ERR_EXTENSION_RUN_UNVERIFIED/);
  });
});

describe("currentRunCredentials", () => {
  async function boundSetup(): Promise<{
    s: Awaited<ReturnType<typeof setup>>;
    entry: ContinuityEntry;
  }> {
    const s = await setup({
      id: "com.example.cred",
      manifest: () => ({ credentials: { token: { env: "X_TOKEN" } } }),
      signed: true,
    });
    s.db.run("UPDATE extension SET source_root_fingerprint = 'root-fp' WHERE id = ?", [
      "com.example.cred",
    ]);
    const entry: ContinuityEntry = {
      legacyServiceId: "readwise",
      extensionId: "com.example.cred",
      publisherKey: s.publisherKey ?? "",
      sourceRootFingerprint: "root-fp",
      credentials: { token: "readwise.token" },
      expectedPermissions: { network: [], read: [], write: [] },
      itemTypes: [],
    };
    await approveExtensionRun("com.example.cred", {
      db: s.db,
      env: s.env,
      gate: gateThat(true, []),
      runtimeEnabled: true,
      now: () => 1,
      continuityTable: [entry],
    });
    return { s, entry };
  }

  test("re-derives exactly what the approval stored, with the binding it came from", async () => {
    const { s, entry } = await boundSetup();
    const live = currentRunCredentials(s.db, "com.example.cred", [entry]);
    expect(live?.binding).toBe(entry);
    expect(live === undefined ? undefined : serializeRunCredentials(live.credentials)).toBe(
      getRunGrant(s.db, "com.example.cred")?.credentials_json,
    );
  });

  test("a row whose source no longer matches resolves unbound", async () => {
    const { s, entry } = await boundSetup();
    s.db.run("UPDATE extension SET source_root_fingerprint = 'other' WHERE id = ?", [
      "com.example.cred",
    ]);
    const live = currentRunCredentials(s.db, "com.example.cred", [entry]);
    expect(live?.binding).toBeUndefined();
    expect(live?.credentials["token"]?.vaultKey).toBe("ext.ext_com_example_cred.token");
  });

  // One case per guard, each from an otherwise-valid setup, so dropping any one guard fails its own.
  // The grant table's foreign key means a grant cannot outlive its row, so "no row" is an id that
  // was never installed, beside a valid bound install.
  test("undefined for an extension that is not installed", async () => {
    const { s, entry } = await boundSetup();
    expect(currentRunCredentials(s.db, "com.example.absent", [entry])).toBeUndefined();
  });

  test("undefined for an installed row with no run grant", async () => {
    const { s, entry } = await boundSetup();
    deleteRunGrant(s.db, "com.example.cred");
    expect(currentRunCredentials(s.db, "com.example.cred", [entry])).toBeUndefined();
  });

  test("undefined when the installed manifest no longer verifies", async () => {
    const { s, entry } = await boundSetup();
    writeFileSync(join(s.installPath, "nimbus.extension.json"), JSON.stringify({ x: 1 }));
    expect(currentRunCredentials(s.db, "com.example.cred", [entry])).toBeUndefined();
  });
});

describe("revokeExtensionRun", () => {
  test("deletes the grant and stops the client; a second revoke is a no-op", async () => {
    const { db, env } = await setup();
    await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, []),
      runtimeEnabled: true,
      now: () => 1,
    });
    const stopped: string[] = [];
    const stop = async (id: string): Promise<void> => {
      stopped.push(id);
    };
    expect(await revokeExtensionRun(db, "com.example.run", stop)).toEqual({
      id: "com.example.run",
      revoked: true,
    });
    expect(await revokeExtensionRun(db, "com.example.run", stop)).toEqual({
      id: "com.example.run",
      revoked: false,
    });
    expect(stopped).toEqual(["com.example.run"]);
    expect(listExtensions(db).map((r) => r.id)).toEqual(["com.example.run"]);
  });

  test("an unknown extension is refused", async () => {
    const { db } = await setup();
    await expect(revokeExtensionRun(db, "nope")).rejects.toThrow(/ERR_EXTENSION_NOT_FOUND/);
  });

  test("a stop failure does not fail the revoke", async () => {
    const { db, env } = await setup();
    await approveExtensionRun("com.example.run", {
      db,
      env,
      gate: gateThat(true, []),
      runtimeEnabled: true,
      now: () => 1,
    });
    const out = await revokeExtensionRun(db, "com.example.run", async () => {
      throw new Error("boom");
    });
    expect(out.revoked).toBe(true);
  });
});

describe("approveMigratedExtensionRun", () => {
  const MIG_ID = "com.example.mig";

  /** A signed, bound extension with credentials, plus its continuity entry. */
  async function migrated(): Promise<{
    s: Awaited<ReturnType<typeof setup>>;
    entry: ContinuityEntry;
    digest: string;
  }> {
    const s = await setup({
      id: MIG_ID,
      signed: true,
      manifest: () => ({ credentials: { token: { env: "FIXTURE_TOKEN" } } }),
    });
    s.db.run("UPDATE extension SET source_root_fingerprint = 'root-fp' WHERE id = ?", [MIG_ID]);
    const entry: ContinuityEntry = {
      legacyServiceId: "fixture_reader",
      extensionId: MIG_ID,
      publisherKey: s.publisherKey ?? "",
      sourceRootFingerprint: "root-fp",
      credentials: { token: "fixture.token" },
      expectedPermissions: { network: [], read: [], write: [] },
      itemTypes: [],
    };
    const digest = listExtensions(s.db).find((r) => r.id === MIG_ID)?.tree_digest ?? "";
    return { s, entry, digest };
  }

  function pending(db: Database, digest: string, extensionId = MIG_ID): void {
    recordMigrationPrepared(
      db,
      {
        id: "mig-1",
        legacyServiceId: "fixture_reader",
        extensionId,
        version: "1.0.0",
        treeDigest: digest,
        stagePath: "/stage",
      },
      1,
    );
  }

  test("with a pending migration it grants the LEGACY vault key, without a prompt, model access off", async () => {
    const { s, entry, digest } = await migrated();
    pending(s.db, digest);
    const out = await approveMigratedExtensionRun(
      { db: s.db, env: s.env, runtimeEnabled: true, now: () => 7, continuityTable: [entry] },
      MIG_ID,
    );
    expect(out.changed).toBe(true);
    expect(out.modelAccess).toBe(false);
    const grant = getRunGrant(s.db, MIG_ID);
    expect(grant?.credentials_json).toBe(
      '{"token":{"env":"FIXTURE_TOKEN","vaultKey":"fixture.token"}}',
    );
    expect(grant?.model_access).toBe(0);
    expect(grant?.tree_digest).toBe(digest);
  });

  test("a blocked extension is never migrated (I48): refused before anything is granted", async () => {
    const { s, entry, digest } = await migrated();
    pending(s.db, digest);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 31);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const stmt = await signTrustStatement(
      {
        kind: "key.revoke",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        publisherId: "test-pub",
        keyFingerprint: publisherKeyFingerprint(s.publisherKey ?? ""),
        reason: "leaked",
      },
      seed,
    );
    recordTrustStatements(s.db, [stmt], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    await expect(
      approveMigratedExtensionRun(
        { db: s.db, env: s.env, runtimeEnabled: true, now: () => 7, continuityTable: [entry] },
        MIG_ID,
      ),
    ).rejects.toThrow("ERR_EXTENSION_KEY_REVOKED");
    expect(getRunGrant(s.db, MIG_ID)).toBeNull();
  });

  test("no pending migration refuses ERR_EXTENSION_RUN_NOT_MIGRATED and grants nothing", async () => {
    const { s, entry } = await migrated();
    await expect(
      approveMigratedExtensionRun(
        { db: s.db, env: s.env, runtimeEnabled: true, now: () => 7, continuityTable: [entry] },
        MIG_ID,
      ),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_MIGRATED/);
    expect(listRunGrants(s.db)).toEqual([]);
  });

  test("a pending migration for a DIFFERENT tree refuses", async () => {
    const { s, entry } = await migrated();
    pending(s.db, "0".repeat(64));
    await expect(
      approveMigratedExtensionRun(
        { db: s.db, env: s.env, runtimeEnabled: true, now: () => 7, continuityTable: [entry] },
        MIG_ID,
      ),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_MIGRATED/);
    expect(listRunGrants(s.db)).toEqual([]);
  });

  test("an extension the continuity table does not bind refuses (no extension-keyspace fallback)", async () => {
    const { s, digest } = await migrated();
    pending(s.db, digest);
    await expect(
      approveMigratedExtensionRun(
        { db: s.db, env: s.env, runtimeEnabled: true, now: () => 7, continuityTable: [] },
        MIG_ID,
      ),
    ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_MIGRATED/);
    expect(listRunGrants(s.db)).toEqual([]);
  });

  test("the runtime switch still refuses first", async () => {
    const { s, entry, digest } = await migrated();
    pending(s.db, digest);
    await expect(
      approveMigratedExtensionRun(
        { db: s.db, env: s.env, runtimeEnabled: false, now: () => 7, continuityTable: [entry] },
        MIG_ID,
      ),
    ).rejects.toThrow(/ERR_EXTENSION_RUNTIME_DISABLED/);
  });
});

describe("approving a blocked extension (I48)", () => {
  const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 21);
  const NIMBUS_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);
  const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS_KEY };
  const ID = "com.example.blocked";

  async function takedown(db: Database, reason: string): Promise<string> {
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: NIMBUS_KEY,
        extensionId: ID,
        publisherId: "test-pub",
        versions: "*",
        reason,
      },
      NIMBUS_SEED,
    );
    expect(recordTrustStatements(db, [s], FEED, 1).inserted).toBe(1);
    return trustStatementId(s);
  }

  const runDeps = (s: Awaited<ReturnType<typeof setup>>, gate: (a: Asked) => Promise<boolean>) => ({
    db: s.db,
    env: s.env,
    gate,
    runtimeEnabled: true,
    now: () => 1,
  });

  test("the prompt shows each block, and the grant acknowledges exactly those ids", async () => {
    const s = await setup({ id: ID, signed: true });
    const id1 = await takedown(s.db, "malware");
    const seen: Asked[] = [];
    await approveExtensionRun(ID, runDeps(s, gateThat(true, seen)));
    const shown = seen[0]?.payload["trustBlocks"] as Array<Record<string, unknown>>;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      statementId: id1,
      kind: "extension.takedown",
      issuer: "nimbus",
      reason: "malware",
    });
    // Nothing the owner must see is hidden by the consent display's redaction.
    expect(JSON.stringify(redactPayloadForConsentDisplay(seen[0]?.payload ?? {}))).toContain(
      "malware",
    );
    expect(getRunGrant(s.db, ID)?.trust_ack_json).toBe(JSON.stringify([id1]));
  });

  test("re-approving an otherwise identical grant after a NEW block prompts again", async () => {
    const s = await setup({ id: ID, signed: true });
    const seen: Asked[] = [];
    await approveExtensionRun(ID, runDeps(s, gateThat(true, seen)));
    expect(getRunGrant(s.db, ID)?.trust_ack_json).toBe("[]");
    const id1 = await takedown(s.db, "later report");
    const out = await approveExtensionRun(ID, runDeps(s, gateThat(true, seen)));
    expect(out.changed).toBe(true);
    expect(seen).toHaveLength(2);
    expect(getRunGrant(s.db, ID)?.trust_ack_json).toBe(JSON.stringify([id1]));
  });

  test("a block that lands while the prompt is open refuses RUN_CHANGED and grants nothing", async () => {
    const s = await setup({ id: ID, signed: true });
    await expect(
      approveExtensionRun(
        ID,
        runDeps(s, async () => {
          await takedown(s.db, "during the prompt");
          return true;
        }),
      ),
    ).rejects.toThrow("ERR_EXTENSION_RUN_CHANGED");
    expect(getRunGrant(s.db, ID)).toBeNull();
  });
});

describe("a starter pack is never approved to run", () => {
  async function packs() {
    const fx = await installStarterPackFixture("nimbus-approve-pack-");
    cleanups.push(fx.cleanup);
    return fx;
  }

  async function refusal(p: Promise<unknown>): Promise<ExtensionRunGrantError> {
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtensionRunGrantError);
    return caught as ExtensionRunGrantError;
  }

  test("approveExtensionRun refuses ERR_EXTENSION_STARTER_PACK naming its transitive code members, before any prompt", async () => {
    const fx = await packs();
    const seen: Asked[] = [];
    const e = await refusal(
      approveExtensionRun(PACK_FIXTURE.topPack, {
        db: fx.db,
        env: fx.env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      }),
    );
    expect(e.code).toBe("ERR_EXTENSION_STARTER_PACK");
    expect(e.message).toBe(`ERR_EXTENSION_STARTER_PACK: ${TOP_PACK_REFUSAL}`);
    expect(seen).toHaveLength(0);
    expect(getRunGrant(fx.db, PACK_FIXTURE.topPack)).toBeNull();
    expect(listRunGrants(fx.db)).toHaveLength(0);
  });

  test("a pack with no members gets the short copy", async () => {
    const fx = await packs();
    const seen: Asked[] = [];
    const e = await refusal(
      approveExtensionRun(PACK_FIXTURE.barePack, {
        db: fx.db,
        env: fx.env,
        gate: gateThat(true, seen),
        runtimeEnabled: true,
        now: () => 1,
      }),
    );
    expect(e.message).toBe(
      `ERR_EXTENSION_STARTER_PACK: ${PACK_FIXTURE.barePack} is a starter pack: it has no code to run.`,
    );
    expect(seen).toHaveLength(0);
    expect(listRunGrants(fx.db)).toHaveLength(0);
  });

  test("a sub-pack lists only its own code member", async () => {
    const fx = await packs();
    const e = await refusal(
      approveExtensionRun(PACK_FIXTURE.subPack, {
        db: fx.db,
        env: fx.env,
        gate: async () => true,
        runtimeEnabled: true,
        now: () => 1,
      }),
    );
    expect(e.message).toBe(
      `ERR_EXTENSION_STARTER_PACK: ${PACK_FIXTURE.subPack} is a starter pack: it has no code to run. Approve its members instead: nimbus extension approve ${PACK_FIXTURE.codeB}`,
    );
  });

  test("the migration auto-approver (I46) refuses a pack too, and grants nothing", async () => {
    const fx = await packs();
    const digest =
      listExtensions(fx.db).find((r) => r.id === PACK_FIXTURE.topPack)?.tree_digest ?? null;
    expect(digest).not.toBeNull();
    recordMigrationPrepared(
      fx.db,
      {
        id: "mig-pack",
        legacyServiceId: "fixture_reader",
        extensionId: PACK_FIXTURE.topPack,
        version: "1.0.0",
        treeDigest: digest ?? "",
        stagePath: "/stage",
      },
      1,
    );
    const e = await refusal(
      approveMigratedExtensionRun(
        { db: fx.db, env: fx.env, runtimeEnabled: true, now: () => 1 },
        PACK_FIXTURE.topPack,
      ),
    );
    expect(e.code).toBe("ERR_EXTENSION_STARTER_PACK");
    expect(e.message).toBe(`ERR_EXTENSION_STARTER_PACK: ${TOP_PACK_REFUSAL}`);
    expect(listRunGrants(fx.db)).toHaveLength(0);
  });

  test("the pack's code members still approve one by one; installing the pack granted them nothing", async () => {
    const fx = await packs();
    expect(listRunGrants(fx.db)).toHaveLength(0);
    const seen: Asked[] = [];
    await approveExtensionRun(PACK_FIXTURE.codeA, {
      db: fx.db,
      env: fx.env,
      gate: gateThat(true, seen),
      runtimeEnabled: true,
      now: () => 1,
    });
    expect(seen).toHaveLength(1);
    expect(listRunGrants(fx.db).map((g) => g.extension_id)).toEqual([PACK_FIXTURE.codeA]);
  });
});
