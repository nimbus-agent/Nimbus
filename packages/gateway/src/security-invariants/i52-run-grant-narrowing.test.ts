import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments, stripStringLiterals } from "../../../../scripts/structure-audit/lib.ts";
import { grepRepo, read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";

describe("I52 — a stored run grant is equal to or narrower than its manifest, and only the owner's approval narrows it", () => {
  // A real install and a real approval with `--network`, then the REAL slot source. Nothing spawns.
  const roots: string[] = [];
  const dbs: Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const ID = "com.example.i52";
  const DECLARED = ["api.example.com", "imap.example.com:993", "smtp.example.com:465"];

  async function narrowed(network: readonly string[]) {
    const { installExtensionFromLocalDirectory } = await import(
      "../extensions/install-from-local.ts"
    );
    const { approveExtensionRun } = await import("../extensions/approve-run.ts");
    const { createExtensionSlotSource } = await import("../extensions/extension-runtime.ts");
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i52-")));
    roots.push(root);
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    const env = {
      platform: process.platform,
      protectedRoots: [join(root, "data"), join(root, "config")],
      runtimeReadPaths: [join(root, "bun-bin")],
      realpath: (p: string) => realpathSync.native(p),
    };
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: ID,
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: {
          network: DECLARED,
          filesystem: { read: [join(root, "outside")], write: [] },
        },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    await installExtensionFromLocalDirectory({
      db,
      extensionsDir: join(root, "data", "extensions"),
      sourcePath: src,
      approve: async () => true,
    });
    const shown: Record<string, unknown>[] = [];
    await approveExtensionRun(ID, {
      db,
      env,
      gate: async (a) => {
        shown.push(a.payload);
        return true;
      },
      runtimeEnabled: true,
      now: () => 1,
      network,
    });
    const source = createExtensionSlotSource({
      db,
      vault: new MockVault(),
      env,
      sandboxDir: join(root, "sandbox"),
      observationDir: join(root, "obs"),
      runtimeReadPaths: () => [join(root, "bun-bin")],
      isConnectorAllowed: () => true,
    });
    const grant = getRunGrant(db, ID);
    if (grant === null) throw new Error("no grant");
    return { db, root, source, grant, shown };
  }

  async function policyNetwork(prepared: { spec: { env: Record<string, string> } }) {
    const { SANDBOX_POLICY_ENV } = await import("../platform/sandbox/sandbox-policy.ts");
    const policy = JSON.parse(prepared.spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      permissions: { network: string[] };
    };
    return policy.permissions.network;
  }

  test("behavioural: a narrowed grant spawns under EXACTLY the stored network, which the owner was shown", async () => {
    const f = await narrowed(["SMTP.example.com:465", "api.example.com"]);
    expect(f.shown[0]?.["network"]).toEqual(["api.example.com", "smtp.example.com:465"]);
    expect(f.shown[0]?.["declaredNetwork"]).toEqual(DECLARED);
    expect(JSON.parse(f.grant.permissions_json).network).toEqual([
      "api.example.com",
      "smtp.example.com:465",
    ]);
    const prepared = await f.source.prepareSpawn(f.grant.service_id);
    expect(await policyNetwork(prepared)).toEqual(["api.example.com", "smtp.example.com:465"]);
  });

  test("behavioural: a narrowed row widened, reordered or re-pointed behind the approval refuses at spawn", async () => {
    const { upsertRunGrant } = await import("../extensions/run-grant-store.ts");
    const { serializeRunGrants } = await import("../extensions/extension-run-grants.ts");
    const { ExtensionRunGrantError } = await import("../extensions/run-grant-error.ts");
    const f = await narrowed([]);
    // Precondition: the narrowed grant prepares, under no network at all.
    expect(await policyNetwork(await f.source.prepareSpawn(f.grant.service_id))).toEqual([]);
    const read = [join(f.root, "outside")];
    for (const grants of [
      { network: ["api.example.com"], read: [f.root], write: [] },
      { network: ["evil.example.com"], read, write: [] },
      { network: ["imap.example.com:993", "api.example.com"], read, write: [] },
      { network: [...DECLARED, "evil.example.com"], read, write: [] },
    ]) {
      upsertRunGrant(f.db, { ...f.grant, permissions_json: serializeRunGrants(grants) });
      const err = await f.source.prepareSpawn(f.grant.service_id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtensionRunGrantError);
      expect((err as InstanceType<typeof ExtensionRunGrantError>).code).toBe(
        "ERR_EXTENSION_RUN_CHANGED",
      );
    }
  });

  test("source pin: the spawn verifier and the approval's post-prompt re-check use the ONE subset rule", async () => {
    const verifier = stripComments(
      await read("packages/gateway/src/extensions/verified-extension.ts"),
    );
    const approval = stripComments(await read("packages/gateway/src/extensions/approve-run.ts"));
    expect(verifier).toMatch(/checkStoredAgainstResolved\(stored, resolved\)/);
    // The spawn's grants are the checked ones, never the stored row's paths.
    expect(verifier).toMatch(/const grants = checked\.grants;/);
    expect(approval).toMatch(/checkStoredAgainstResolved\(\s*prompted,/);
    expect(approval).toMatch(/!stillWithinReresolved\(grants, manifest, after\.install_path/);
    // Nobody else defines a second subset rule.
    const definers = await grepRepo(/function checkStoredAgainstResolved\(/);
    expect(definers).toEqual(["packages/gateway/src/extensions/extension-run-grants.ts"]);
  });

  test("source pin: only approve-run.ts writes a grant (D33(c)), and the migration door cannot carry a network", async () => {
    const writers = (await readDirFiles("packages/gateway/src"))
      .filter((f) => /\bupsertRunGrant\b/.test(stripStringLiterals(stripComments(f.contents))))
      .map((f) => f.rel)
      .sort((a, b) => a.localeCompare(b));
    expect(writers).toEqual(["extensions/approve-run.ts", "extensions/run-grant-store.ts"]);
    const approval = stripComments(await read("packages/gateway/src/extensions/approve-run.ts"));
    expect(approval).toMatch(
      /export async function approveMigratedExtensionRun\(\s*deps: Omit<ApproveExtensionRunDeps, "gate" \| "modelAccess" \| "network">/,
    );
    // The refusal runs at the top of approveRun, before the row is read or anything resolved.
    const body = approval.slice(approval.indexOf("async function approveRun("));
    const guardAt = body.indexOf("assertNarrowingIsPrompted(deps.network, opts.consent");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf("requireRow("));
  });

  test("a delegate never approves a narrowing: extension.run still reaches only the local owner (I20)", async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    let prompts = 0;
    let remote = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      { dispatch: async () => ({}) },
      {
        store: { activeDelegateFor: () => true, activeDelegateePeer: () => "peer-1" },
        isOperatorValid: () => true,
        requestRemote: async () => {
          remote += 1;
          return { kind: "answered", peerId: "peer-1", approved: true };
        },
      },
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({
      type: "extension.run",
      payload: { id: ID, network: [], declaredNetwork: DECLARED, networkNarrowed: true },
    });
    expect(res.status).toBe("rejected");
    expect(remote).toBe(0);
    expect(prompts).toBe(1);
  });
});
