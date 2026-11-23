import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { listExtensions } from "../automation/extension-store.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { encodeBase64 } from "../util/base64.ts";
import { generateEd25519Keypair } from "../util/ed25519.ts";

describe("I43 — an installed extension's code runs only through the verified spawn path", () => {
  // A real install through the installer and a real approval through `approveExtensionRun`, so the
  // row and the grant are exactly what production writes; then the REAL slot source (no injected
  // verifier) is asked to prepare a spawn. Nothing here spawns a process.
  const roots: string[] = [];
  const dbs: Database[] = [];
  afterEach(async () => {
    for (const db of dbs.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    const { signatureDisabledRegistry } = await import("../extensions/hard-disable.ts");
    signatureDisabledRegistry.reset();
  });

  async function installAndMaybeApprove(
    opts: {
      signed?: boolean;
      approve?: boolean;
      stage?: import("../extensions/extension-stage.ts").ExtensionStageDeps;
      /** Declare one credential, `token` -> env `I43_TOKEN`. */
      credential?: boolean;
      /** The manifest's declared network; absent means `["api.example.com"]`. */
      declared?: string[];
      /** I52: approve with `--network` narrowed to these entries. */
      network?: readonly string[];
    } = {},
  ) {
    const { installExtensionFromLocalDirectory } = await import(
      "../extensions/install-from-local.ts"
    );
    const { approveExtensionRun } = await import("../extensions/approve-run.ts");
    const { signManifest } = await import("../extensions/verify-signature.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i43-")));
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
    const vault = new MockVault();
    const id = "com.example.i43";
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    const manifest: Record<string, unknown> = {
      id,
      version: "1.0.0",
      entry: "dist/index.js",
      permissions: {
        network: opts.declared ?? ["api.example.com"],
        filesystem: { read: [join(root, "outside")], write: [] },
      },
      ...(opts.credential === true ? { credentials: { token: { env: "I43_TOKEN" } } } : {}),
    };
    let publisherKeyPath: string | undefined;
    if (opts.signed === true) {
      const kp = generateEd25519Keypair();
      manifest["publisher"] = { id: "i43-pub", key: encodeBase64(kp.pubkey) };
      manifest["signature"] = await signManifest(manifest, kp.privkey);
      publisherKeyPath = join(root, "pub.key");
      writeFileSync(publisherKeyPath, `${encodeBase64(kp.pubkey)}\n`);
    }
    writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    writeFileSync(join(src, "dist", "chunk.js"), "export const x = 1;\n");
    const extensionsDir = join(root, "data", "extensions");
    await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: src,
      approve: async () => true,
      ...(publisherKeyPath === undefined
        ? {}
        : {
            vault,
            publisherKeyPath,
          }),
    });
    if (opts.approve !== false) {
      await approveExtensionRun(id, {
        db,
        env,
        gate: async () => true,
        runtimeEnabled: true,
        now: () => 1,
        ...(opts.network === undefined ? {} : { network: opts.network }),
      });
    }
    const { createExtensionSlotSource } = await import("../extensions/extension-runtime.ts");
    const source = createExtensionSlotSource({
      db,
      vault,
      env,
      sandboxDir: join(root, "sandbox"),
      observationDir: join(root, "obs"),
      runtimeReadPaths: () => [join(root, "bun-bin")],
      isConnectorAllowed: () => true,
      ...(opts.stage === undefined ? {} : { stage: opts.stage }),
    });
    const sandboxDir = join(root, "sandbox");
    return { db, vault, id, source, installPath: join(extensionsDir, id), sandboxDir, root };
  }

  async function refusalCode(p: Promise<unknown>): Promise<string> {
    const { ExtensionRunGrantError } = await import("../extensions/run-grant-error.ts");
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(ExtensionRunGrantError);
      return (e as InstanceType<typeof ExtensionRunGrantError>).code;
    }
    throw new Error("prepareSpawn resolved; expected a refusal");
  }

  test("behavioural: the happy path yields a sandboxed ext.<serviceId> spec running a verified copy in a fresh stage", async () => {
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const { SANDBOX_POLICY_ENV, SANDBOX_CWD_ENV } = await import(
      "../platform/sandbox/sandbox-policy.ts"
    );
    const { extensionStageRootFor, sandboxCwdFor } = await import(
      "../platform/sandbox/sandbox-cwd.ts"
    );
    const { computeExtensionTreeDigest } = await import("../extensions/tree-digest.ts");
    const f = await installAndMaybeApprove();
    const serviceId = getRunGrant(f.db, f.id)?.service_id ?? "";
    expect(serviceId).toMatch(/^ext_[a-z0-9_]+$/);
    const prepared = await f.source.prepareSpawn(serviceId);
    expect(prepared.serviceId).toBe(serviceId);
    const policy = JSON.parse(prepared.spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      id: string;
      permissions: { network: string[]; filesystem: { read: string[] } };
    };
    expect(policy.id).toBe(`ext.${serviceId}`);
    expect(policy.permissions.network).toEqual(["api.example.com"]);
    // The entry is inside a fresh <uuid> stage under ext-stage/<serviceId>, whose tree digest
    // equals the approved one, and that stage is the child's working directory. The long-lived
    // per-policy leaf is not used (or created); the install tree is not granted at all.
    const stageRoot = extensionStageRootFor(f.sandboxDir, serviceId);
    const entry = prepared.spec.args.at(-1) ?? "";
    const stageName = readdirSync(stageRoot)[0] ?? "";
    expect(readdirSync(stageRoot)).toEqual([stageName]);
    expect(stageName).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry).toBe(join(stageRoot, stageName, "dist", "index.js"));
    expect(prepared.spec.env[SANDBOX_CWD_ENV]).toBe(join(stageRoot, stageName));
    expect(existsSync(sandboxCwdFor(f.sandboxDir, `ext.${serviceId}`))).toBe(false);
    expect(computeExtensionTreeDigest(join(stageRoot, stageName))).toBe(
      getRunGrant(f.db, f.id)?.tree_digest ?? "",
    );
    expect(policy.permissions.filesystem.read.filter((p) => p.startsWith(f.installPath))).toEqual(
      [],
    );
  });

  test("behavioural: bunfig.toml / .env / node_modules planted in the old leaf or the stage root never reach the spawn's cwd", async () => {
    // Bun honours `<cwd>/bunfig.toml` (a `preload` runs before the entry), `<cwd>/.env` and
    // `node_modules` found walking up from the importing file; none is digested. Planted where a
    // previous run (old leaf) or a same-user process (stage root) could write, they must not be in
    // the directory the child starts in, nor on its upward module path.
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const { SANDBOX_CWD_ENV } = await import("../platform/sandbox/sandbox-policy.ts");
    const { extensionStageRootFor, sandboxCwdFor } = await import(
      "../platform/sandbox/sandbox-cwd.ts"
    );
    const f = await installAndMaybeApprove();
    const serviceId = getRunGrant(f.db, f.id)?.service_id ?? "";
    const leaf = sandboxCwdFor(f.sandboxDir, `ext.${serviceId}`);
    const stageRoot = extensionStageRootFor(f.sandboxDir, serviceId);
    const plant = (dir: string): void => {
      mkdirSync(join(dir, "node_modules", "evil-pkg"), { recursive: true });
      writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      writeFileSync(join(dir, "preload.ts"), 'require("node:fs").writeFileSync("MARKER", "x");\n');
      writeFileSync(join(dir, ".env"), "NIMBUS_PLANTED=1\n");
      writeFileSync(join(dir, "node_modules", "evil-pkg", "index.js"), "module.exports = 1;\n");
    };
    plant(leaf);
    plant(stageRoot);
    // An earlier stage, too, carrying the same plants.
    plant(join(stageRoot, "00000000-0000-4000-8000-000000000000"));
    const prepared = await f.source.prepareSpawn(serviceId);
    const cwd = prepared.spec.env[SANDBOX_CWD_ENV] ?? "";
    // The cwd is a fresh stage directly under the stage root…
    expect(join(cwd, "..")).toBe(stageRoot);
    // …holding exactly the digested install tree, nothing else.
    const listTree = (root: string, rel = ""): string[] =>
      readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? listTree(root, join(rel, e.name))
          : [join(rel, e.name).replaceAll("\\", "/")],
      );
    expect(listTree(cwd).sort()).toEqual(listTree(f.installPath).sort());
    // The stage root's planted files and the earlier stage were swept: the only thing on the
    // child's upward path below the sandbox root is its own stage.
    expect(readdirSync(stageRoot)).toEqual([cwd.slice(stageRoot.length + 1)]);
    // The old leaf is not the cwd and is not on its path at all.
    expect(cwd.startsWith(leaf)).toBe(false);
    expect(prepared.spec.args.some((a) => a.startsWith(leaf))).toBe(false);
  });

  test("behavioural: a staged copy that differs from the verified tree refuses, leaving no stage", async () => {
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const { copyRegularTree } = await import("../extensions/extension-stage.ts");
    const { extensionStageRootFor } = await import("../platform/sandbox/sandbox-cwd.ts");
    const f = await installAndMaybeApprove({
      stage: {
        copyTree: (from, to) => {
          copyRegularTree(from, to);
          writeFileSync(join(to, "dist", "chunk.js"), "evil();\n");
        },
      },
    });
    const serviceId = getRunGrant(f.db, f.id)?.service_id ?? "";
    expect(await refusalCode(f.source.prepareSpawn(serviceId))).toBe(
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
    expect(readdirSync(extensionStageRootFor(f.sandboxDir, serviceId))).toEqual([]);
  });

  test("behavioural: no run grant refuses", async () => {
    const { deriveExtensionServiceId } = await import("../extensions/extension-service-id.ts");
    const f = await installAndMaybeApprove({ approve: false });
    expect(await refusalCode(f.source.prepareSpawn(deriveExtensionServiceId(f.id)))).toBe(
      "ERR_EXTENSION_RUN_NOT_APPROVED",
    );
  });

  test("behavioural: a tree changed after approval (stale digest) refuses", async () => {
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const f = await installAndMaybeApprove();
    writeFileSync(join(f.installPath, "dist", "chunk.js"), "evil();\n");
    const serviceId = getRunGrant(f.db, f.id)?.service_id ?? "";
    expect(await refusalCode(f.source.prepareSpawn(serviceId))).toBe(
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
  });

  test("behavioural: a stored grant that is not a subset of the re-resolved one refuses", async () => {
    const { getRunGrant, upsertRunGrant } = await import("../extensions/run-grant-store.ts");
    const { serializeRunGrants } = await import("../extensions/extension-run-grants.ts");
    const f = await installAndMaybeApprove();
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    const read = [join(f.root, "outside")];
    // Precondition: the approved grant prepares, so each refusal below is the tampered row's.
    await f.source.prepareSpawn(g.service_id);
    for (const grants of [
      { network: ["x.example.com"], read, write: [] },
      { network: ["api.example.com", "x.example.com"], read, write: [] },
      { network: ["api.example.com", "api.example.com"], read, write: [] },
      { network: ["api.example.com"], read: [], write: [] },
      { network: ["api.example.com"], read: [f.root], write: [] },
    ]) {
      upsertRunGrant(f.db, { ...g, permissions_json: serializeRunGrants(grants) });
      expect(await refusalCode(f.source.prepareSpawn(g.service_id))).toBe(
        "ERR_EXTENSION_RUN_CHANGED",
      );
    }
  });

  test("behavioural: a stored network narrower than the manifest prepares, under the stored network only", async () => {
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const { SANDBOX_POLICY_ENV } = await import("../platform/sandbox/sandbox-policy.ts");
    const f = await installAndMaybeApprove({
      declared: ["api.example.com", "imap.example.com:993"],
      network: ["imap.example.com:993"],
    });
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    const prepared = await f.source.prepareSpawn(g.service_id);
    const policy = JSON.parse(prepared.spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      permissions: { network: string[]; filesystem: { read: string[] } };
    };
    expect(policy.permissions.network).toEqual(["imap.example.com:993"]);
    expect(policy.permissions.filesystem.read).toContain(join(f.root, "outside"));
  });

  test("behavioural: a publisher manifest that fails I16 at spawn (key gone from the Vault) refuses", async () => {
    const { getRunGrant } = await import("../extensions/run-grant-store.ts");
    const { evictPublisherKey } = await import("../extensions/publisher-keys.ts");
    const f = await installAndMaybeApprove({ signed: true });
    const serviceId = getRunGrant(f.db, f.id)?.service_id ?? "";
    // Precondition: the signed extension prepares while its key is cached.
    await f.source.prepareSpawn(serviceId);
    await evictPublisherKey(f.vault, "i43-pub");
    expect(await refusalCode(f.source.prepareSpawn(serviceId))).toBe(
      "ERR_EXTENSION_RUN_UNVERIFIED",
    );
  });

  test("a starter pack is never granted extension.run and never spawned", async () => {
    const { installStarterPackFixture, PACK_FIXTURE } = await import(
      "../../test/helpers/starter-pack-fixture.ts"
    );
    const { approveExtensionRun } = await import("../extensions/approve-run.ts");
    const { getRunGrant, listRunGrants, upsertRunGrant } = await import(
      "../extensions/run-grant-store.ts"
    );
    const { serializeRunGrants } = await import("../extensions/extension-run-grants.ts");
    const { createExtensionSlotSource } = await import("../extensions/extension-runtime.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const fx = await installStarterPackFixture("nimbus-i43-pack-");
    try {
      // Approval: refused before the owner is asked, and no grant row exists afterwards.
      let asked = 0;
      expect(
        await refusalCode(
          approveExtensionRun(PACK_FIXTURE.topPack, {
            db: fx.db,
            env: fx.env,
            gate: async () => {
              asked++;
              return true;
            },
            runtimeEnabled: true,
            now: () => 1,
          }),
        ),
      ).toBe("ERR_EXTENSION_STARTER_PACK");
      expect(asked).toBe(0);
      expect(getRunGrant(fx.db, PACK_FIXTURE.topPack)).toBeNull();
      expect(listRunGrants(fx.db)).toEqual([]);
      // Spawn: even a grant row that got there some other way prepares no spawn of a pack.
      const row = listExtensions(fx.db).find((r) => r.id === PACK_FIXTURE.topPack);
      upsertRunGrant(fx.db, {
        extension_id: PACK_FIXTURE.topPack,
        service_id: "ext_fx_pack_top",
        version: "1.0.0",
        tree_digest: row?.tree_digest ?? "",
        permissions_json: serializeRunGrants({ network: [], read: [], write: [] }),
        model_access: 0,
        approved_at: 1,
        credentials_json: "{}",
      });
      const source = createExtensionSlotSource({
        db: fx.db,
        vault: new MockVault(),
        env: fx.env,
        sandboxDir: join(fx.root, "sandbox"),
        observationDir: join(fx.root, "obs"),
        runtimeReadPaths: () => [],
        isConnectorAllowed: () => true,
      });
      expect(await refusalCode(source.prepareSpawn("ext_fx_pack_top"))).toBe(
        "ERR_EXTENSION_STARTER_PACK",
      );
    } finally {
      fx.cleanup();
    }
  });

  test("source pin: prepareSpawn verifies through readVerifiedExtensionForSpawn BEFORE it builds the spec", async () => {
    const src = stripComments(await read("packages/gateway/src/extensions/extension-runtime.ts"));
    const fnAt = src.indexOf("export function createExtensionSlotSource(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt);
    // The verifier defaults to the real one; the `verify` seam is a test injection only.
    expect(body).toMatch(/const verify = deps\.verify \?\? readVerifiedExtensionForSpawn;/);
    const prepAt = body.indexOf("async prepareSpawn(");
    expect(prepAt).toBeGreaterThan(-1);
    const prep = body.slice(prepAt);
    const verifyAt = prep.indexOf("await verify(");
    const buildAt = prep.indexOf("buildExtensionSpawnSpec(");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(verifyAt);
    // Between the two, the VERIFIED tree is staged and its copy re-digested; the spec is built from
    // the STAGED value, never from the raw grant row or the unstaged install tree.
    const stageAt = prep.indexOf("stageVerifiedExtension(");
    expect(stageAt).toBeGreaterThan(verifyAt);
    expect(buildAt).toBeGreaterThan(stageAt);
    expect(prep).toMatch(/stageVerifiedExtension\(\s*verified,/);
    expect(prep).toMatch(/buildExtensionSpawnSpec\(staged,/);
    // The stage refuses unless the COPY's digest equals the verified digest, before it returns.
    const stage = stripComments(await read("packages/gateway/src/extensions/extension-stage.ts"));
    const stageFnAt = stage.indexOf("export function stageVerifiedExtension(");
    expect(stageFnAt).toBeGreaterThan(-1);
    const stageBody = stage.slice(stageFnAt);
    const digestAt = stageBody.indexOf("staged = digest(stagePath);");
    const checkAt = stageBody.search(
      /if \(staged !== v\.treeDigest\) \{\s*removeBestEffort\(stagePath\);\s*refuseTreeChanged\(/,
    );
    expect(digestAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(digestAt);
    expect(stageBody.indexOf("return {", checkAt)).toBeGreaterThan(checkAt);
    expect(stage).toMatch(/const digest = deps\.treeDigest \?\? computeExtensionTreeDigest;/);
    // The spec is wrapped (I15) with the STAGE as the exact working directory — never the
    // long-lived per-policy leaf `wrapServerSpec` derives — and the manifest id is `ext.<serviceId>`.
    expect(src).toMatch(/return wrapServerSpecInCwd\(/);
    expect(src).not.toMatch(/\bwrapServerSpec\(/);
    // The stage is the cwd; the only fourth argument is the wrapper-only observation pair.
    expect(src).toMatch(
      /v\.stagePath,\s*observationWrapperEnv\(deps\.observationPrefix, v\),\s*\);/,
    );
    expect(prep).toMatch(/extensionStageRootFor\(deps\.sandboxDir, verified\.serviceId\)/);
    expect(src).toMatch(/id: `ext\.\$\{v\.serviceId\}`,/);
    // Production never injects a verifier: the one construction site passes no `verify`.
    const assemble = stripComments(
      await read("packages/gateway/src/platform/assemble/scheduler-mesh.ts"),
    );
    const callAt = assemble.indexOf("createExtensionSlotSource({");
    expect(callAt).toBeGreaterThan(-1);
    const call = assemble.slice(callAt, assemble.indexOf("})", callAt));
    expect(call).not.toMatch(/\bverify\b/);
    expect(assemble.indexOf("createExtensionSlotSource(", callAt + 1)).toBe(-1);
  });

  test("the spec builders are named only by extension-runtime.ts, and the spec is built once, inside prepareSpawn", async () => {
    // Both builders are exported (unit tests use them) and take a plain interface, so a second
    // production caller could build a launchable spec without the verifier. D33(a) cannot see that:
    // the sentinel stays in `platform/runtime-layout.ts` and `selfSpawn("extension"` in
    // `extension-launch-command.ts`, whose callers D38(b) confines to the two builders (this one
    // and the eval builder), so a second caller of THIS builder trips neither. Any mention elsewhere — a
    // call, an import, an aliased import — fails here.
    const files = await readDirFiles("packages/gateway/src");
    const builderRe = /\b(?:buildExtensionSpawnSpec|buildExtensionRuntimeManifest)\b/;
    const outside = files
      .filter((f) => f.rel !== "extensions/extension-runtime.ts")
      .filter((f) => builderRe.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(outside).toEqual([]);
    const src = stripComments(await read("packages/gateway/src/extensions/extension-runtime.ts"));
    // Call sites, not definitions.
    const callsOf = (name: string): number[] =>
      [...src.matchAll(new RegExp(`(?<!function )\\b${name}\\(`, "g"))].map((m) => m.index);
    const specCalls = callsOf("buildExtensionSpawnSpec");
    expect(specCalls).toHaveLength(1);
    const prepAt = src.indexOf("async prepareSpawn(");
    expect(prepAt).toBeGreaterThan(-1);
    expect(specCalls[0]).toBeGreaterThan(prepAt);
    expect(specCalls[0]).toBeGreaterThan(src.indexOf("await verify(", prepAt));
    expect(specCalls[0]).toBeGreaterThan(src.indexOf("stageVerifiedExtension(", prepAt));
    // The stager is named only by its definition and by prepareSpawn, which calls it once.
    const stagerOutside = files
      .filter(
        (f) =>
          f.rel !== "extensions/extension-runtime.ts" && f.rel !== "extensions/extension-stage.ts",
      )
      .filter((f) => /\bstageVerifiedExtension\b/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(stagerOutside).toEqual([]);
    expect(callsOf("stageVerifiedExtension")).toHaveLength(1);
    // The manifest builder is called once, from inside the spec builder.
    const manifestCalls = callsOf("buildExtensionRuntimeManifest");
    expect(manifestCalls).toHaveLength(1);
    const specDefAt = src.indexOf("export function buildExtensionSpawnSpec(");
    expect(manifestCalls[0]).toBeGreaterThan(specDefAt);
    expect(manifestCalls[0]).toBeLessThan(src.indexOf("export type ExtensionSlotSourceDeps"));
  });

  test("behavioural: a granted credential reaches the spec env with its Vault value; ungranted secrets and a stale mapping do not", async () => {
    const { getRunGrant, upsertRunGrant } = await import("../extensions/run-grant-store.ts");
    const { extensionProcessEnv } = await import("../extensions/spawn-env.ts");
    const { sandboxWrapperOnlyEnv } = await import("../platform/sandbox/sandbox-policy.ts");
    const {
      SANDBOX_POLICY_ENV,
      SANDBOX_CWD_ENV,
      SANDBOX_OBSERVATION_FILE_ENV,
      SANDBOX_OBSERVATION_LABEL_ENV,
    } = await import("../platform/sandbox/sandbox-policy.ts");
    const { wrapperChildEnv } = await import("../platform/sandbox/sandbox-wrapper.ts");
    const f = await installAndMaybeApprove({ credential: true });
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    const ownKey = `ext.${g.service_id}.token`;
    expect(JSON.parse(g.credentials_json)).toEqual({
      token: { env: "I43_TOKEN", vaultKey: ownKey },
    });
    await f.vault.set(ownKey, "i43-granted-value");
    await f.vault.set("github.pat", "i43-ungranted-value");
    const prepared = await f.source.prepareSpawn(g.service_id);
    expect(prepared.spec.env["I43_TOKEN"]).toBe("i43-granted-value");
    const allowed = new Set([
      ...Object.keys(extensionProcessEnv({})),
      // For the wrapper, which strips them before the child starts.
      ...Object.keys(sandboxWrapperOnlyEnv()),
      SANDBOX_POLICY_ENV,
      SANDBOX_CWD_ENV,
      // The observation channel: for the wrapper, which strips both before the child starts.
      SANDBOX_OBSERVATION_FILE_ENV,
      SANDBOX_OBSERVATION_LABEL_ENV,
      "I43_TOKEN",
    ]);
    expect(Object.keys(prepared.spec.env).filter((k) => !allowed.has(k))).toEqual([]);
    // What the wrapper hands its child is exactly the I1 env with the granted credential: neither
    // the observation prefix nor its label reaches the child.
    expect(wrapperChildEnv(prepared.spec.env)).toEqual(
      extensionProcessEnv({ I43_TOKEN: "i43-granted-value" }),
    );
    expect(Object.values(prepared.spec.env)).not.toContain("i43-ungranted-value");
    expect(JSON.stringify(prepared.spec.args)).not.toContain("i43-granted-value");
    prepared.discard();
    // A stored credential mapping that no longer equals the re-resolved one refuses the spawn.
    upsertRunGrant(f.db, {
      ...g,
      credentials_json: JSON.stringify({ token: { env: "I43_TOKEN", vaultKey: "github.pat" } }),
    });
    expect(await refusalCode(f.source.prepareSpawn(g.service_id))).toBe(
      "ERR_EXTENSION_RUN_CHANGED",
    );
  });

  test("source pin: the observation keys ride only wrapServerSpecInCwd's wrapper-only fourth argument, from a directory in no grant", async () => {
    const src = stripComments(await read("packages/gateway/src/extensions/extension-runtime.ts"));
    // The pair is built in one place, from exactly the two wrapper-only names.
    const fnAt = src.indexOf("function observationWrapperEnv(");
    expect(fnAt).toBeGreaterThan(-1);
    const fn = src.slice(fnAt, src.indexOf("\n}\n", fnAt));
    expect(fn).toMatch(/\[SANDBOX_OBSERVATION_FILE_ENV\]: prefix,/);
    expect(fn).toMatch(
      /\[SANDBOX_OBSERVATION_LABEL_ENV\]: JSON\.stringify\(\{\s*extensionId: v\.extensionId,\s*version: v\.version,?\s*\}\)/,
    );
    expect(src.match(/observationWrapperEnv\(/g) ?? []).toHaveLength(2);
    // prepareSpawn derives the prefix from the gateway's observation directory per spawn.
    const prep = src.slice(src.indexOf("async prepareSpawn("));
    expect(prep).toMatch(
      /observationPrefix: observationPrefixFor\(deps\.observationDir, staged\.serviceId\),/,
    );
    // wrapServerSpecInCwd accepts the two observation keys and nothing else.
    const wrap = stripComments(
      await read("packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts"),
    );
    expect(wrap).toMatch(/if \(wrapperEnv !== undefined\) assertWrapperOnly\(wrapperEnv\);/);
    expect(wrap).toMatch(
      /const WRAPPER_ENV_KEYS: ReadonlySet<string> = new Set\(\[\s*SANDBOX_OBSERVATION_FILE_ENV,\s*SANDBOX_OBSERVATION_LABEL_ENV,\s*\]\);/,
    );
    expect(wrap).toMatch(
      /if \(!WRAPPER_ENV_KEYS\.has\(key\) \|\| !isSandboxWrapperOnlyEnv\(key\)\) \{\s*throw new Error\(/,
    );
    // The directory is the gateway's own: the runtime read paths never name it, and the slot
    // source gets it only as `observationDir`.
    const assemble = stripComments(
      await read("packages/gateway/src/platform/assemble/scheduler-mesh.ts"),
    );
    const callAt = assemble.indexOf("createExtensionSlotSource({");
    const call = assemble.slice(callAt, assemble.indexOf("})", callAt));
    expect(call).toMatch(/observationDir: extensionObservationDir,/);
    expect(call).toMatch(
      /runtimeReadPaths: \(\) => resolveRuntimeById\("bun"\)\.requiredReadPaths\(\),/,
    );
  });

  test("source pin: credential values reach the child ONLY as extensionProcessEnv's extra, read after verification", async () => {
    const src = stripComments(await read("packages/gateway/src/extensions/extension-runtime.ts"));
    // The spec's env is built in exactly one place, from the credential env and nothing else.
    expect(src.match(/\benv:/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/\{ command, args, env: extensionProcessEnv\(deps\.credentialEnv\) \}/);
    expect(src.match(/extensionProcessEnv\(/g) ?? []).toHaveLength(1);
    // prepareSpawn reads the values for the VERIFIED credentials, after the verifier and before
    // staging, and hands them to the spec builder.
    const prepAt = src.indexOf("async prepareSpawn(");
    const prep = src.slice(prepAt);
    const readAt = prep.indexOf(
      "const credentialEnv = await readCredentialEnv(deps.vault, verified.credentials);",
    );
    expect(readAt).toBeGreaterThan(prep.indexOf("await verify("));
    expect(prep.indexOf("stageVerifiedExtension(")).toBeGreaterThan(readAt);
    expect(prep).toMatch(/buildExtensionSpawnSpec\(staged, \{[^}]*\bcredentialEnv,\s*\}\)/);
    // The Vault-reading helper has no other production caller.
    const files = await readDirFiles("packages/gateway/src");
    const readers = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /\breadCredentialEnv\(/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(readers).toEqual([
      "extensions/extension-credentials.ts",
      "extensions/extension-runtime.ts",
    ]);
    // The verifier re-resolves the credentials from the manifest it verified — through the ONE
    // derivation it shares with the approval (`resolvedCredentialsFor`), called only after the
    // manifest's hashes and publisher signature are verified — and compares them with the stored
    // grant, refusing RUN_CHANGED on any difference.
    const ver = stripComments(await read("packages/gateway/src/extensions/verified-extension.ts"));
    expect(ver).toMatch(
      /import \{[^}]*\bresolvedCredentialsFor\b[^}]*\} from "\.\/approve-run\.ts";/,
    );
    const verify = ver.slice(ver.indexOf("export async function readVerifiedExtensionForSpawn("));
    const hashesAt = verify.indexOf("assertHashesVerified(row);");
    const manifestAt = verify.indexOf("const manifest = readManifestTyped(row);");
    const signatureAt = verify.indexOf(
      "await assertPublisherSignature(deps.db, row, manifest, grant, deps.vault);",
    );
    const deriveAt = verify.search(
      /const \{ credentials \} = resolvedCredentialsFor\(\s*row,\s*manifest,\s*grant\.service_id,/,
    );
    const compareAt = verify.search(
      /if \(serializeRunCredentials\(credentials\) !== grant\.credentials_json\) \{\s*refuse\(\s*"ERR_EXTENSION_RUN_CHANGED",/,
    );
    for (const at of [hashesAt, manifestAt, signatureAt]) expect(at).toBeGreaterThan(-1);
    expect(deriveAt).toBeGreaterThan(Math.max(hashesAt, manifestAt, signatureAt));
    expect(compareAt).toBeGreaterThan(deriveAt);
    expect(verify.match(/resolvedCredentialsFor\(/g) ?? []).toHaveLength(1);
    // …and that derivation binds from the row and the manifest it is handed (the verified one).
    const approve = stripComments(await read("packages/gateway/src/extensions/approve-run.ts"));
    const derive = approve.slice(
      approve.indexOf("export function resolvedCredentialsFor("),
      approve.indexOf("export function currentRunCredentials("),
    );
    expect(derive).toMatch(
      /const binding = findContinuityBinding\(bindingInputFor\(row, manifest\), table\);/,
    );
    expect(derive).toMatch(/resolveRunCredentials\(manifest, serviceId, binding\)/);
  });

  test("behavioural: a credential env name that could change what the child runs is refused at parse", async () => {
    const { parseExtensionManifestJson } = await import("../extensions/manifest.ts");
    const { BASELINE_KEYS } = await import("../extensions/spawn-env.ts");
    const reserved = [
      "NODE_OPTIONS",
      "BUN_X",
      "NIMBUS_X",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "COMSPEC",
      "PATHEXT",
      ...BASELINE_KEYS,
    ];
    for (const env of reserved) {
      expect(() =>
        parseExtensionManifestJson(
          JSON.stringify({ id: "x", version: "1.0.0", credentials: { token: { env } } }),
        ),
      ).toThrow(/reserved variable/);
    }
    // Positive control: an ordinary name parses, so the refusals above are about the NAME.
    const ok = parseExtensionManifestJson(
      JSON.stringify({ id: "x", version: "1.0.0", credentials: { token: { env: "I43_TOKEN" } } }),
    );
    expect(ok.credentials).toEqual({ token: { env: "I43_TOKEN" } });
    // The CALLS, not the names: removing either check from the parser fails here.
    const src = stripComments(await read("packages/registry-format/src/manifest.ts"));
    expect(src).toMatch(/!CREDENTIAL_ENV_RE\.test\(env\) \|\| isReservedEnv\(env\)/);
    expect(src).toMatch(/isExtensionBaselineEnvKey\(env\)/);
  });

  test("the run grant is created only behind the executor-gated extension.run approval (I2 frozen set)", () => {
    expect(HITL_REQUIRED.has("extension.run")).toBe(true);
  });

  test("stopping an extension stops its mesh:ext: slot, keyed by extensionMeshKey", async () => {
    const lm = "packages/gateway/src/connectors/lazy-mesh/mesh/";
    const src = stripComments(await read(`${lm}extension-layer.ts`));
    const fnAt = src.indexOf("public async stopExtensionClient(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt, src.indexOf("\n  }\n", fnAt));
    expect(body).toContain("this.stopLazyClient(extensionMeshKey(");
  });

  test("D33(a): the real tree names the self-role only where allowed, and the checker does reject a stray one", async () => {
    const { checkExtensionRoleConfinement } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(files.length).toBeGreaterThan(100);
    expect(checkExtensionRoleConfinement(files)).toEqual([]);
    // Non-vacuous: the same checker flags a planted sentinel and a planted selfSpawn.
    const planted = checkExtensionRoleConfinement([
      { relPath: "packages/gateway/src/x/y.ts", contents: 'const r = "__nimbus-extension";\n' },
      { relPath: "packages/gateway/src/x/z.ts", contents: 'selfSpawn("extension", [p]);\n' },
    ]);
    expect(planted.map((v) => v.file)).toEqual([
      "packages/gateway/src/x/y.ts",
      "packages/gateway/src/x/z.ts",
    ]);
  });

  test("D34: the real tree confines the migration table, the migration grant and the extension.migrate consent, and the checker rejects strays", async () => {
    const { checkMigrationConfinement } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(files.length).toBeGreaterThan(100);
    // Premise: the confined names are really present in the scanned tree.
    const named = (re: RegExp) => files.filter((f) => re.test(f.contents)).length;
    expect(named(/\bconnector_migration\b/)).toBeGreaterThan(0);
    expect(named(/\bapproveMigratedExtensionRun\b/)).toBeGreaterThan(0);
    expect(named(/\bmigrationConsentViaGate\b/)).toBeGreaterThan(0);
    expect(checkMigrationConfinement(files)).toEqual([]);
    // Non-vacuous: the same checker flags one planted stray per clause.
    const planted = checkMigrationConfinement([
      {
        relPath: "packages/gateway/src/x/a.ts",
        contents: "db.run(\"UPDATE connector_migration SET state = 'approved'\");\n",
      },
      {
        relPath: "packages/gateway/src/x/b.ts",
        contents: "await approveMigratedExtensionRun(d, id);\n",
      },
      {
        relPath: "packages/gateway/src/x/c.ts",
        contents: 'gate({ type: "extension.migrate", payload });\n',
      },
    ]);
    expect(planted.map((v) => [v.file, v.rule])).toEqual([
      ["packages/gateway/src/x/a.ts", "migration-table-confined"],
      ["packages/gateway/src/x/b.ts", "migration-grant-callers"],
      ["packages/gateway/src/x/c.ts", "migration-consent-raisers"],
    ]);
  });

  test("D34 bound: inside dispatchers.ts only tryDispatchMigrationRpc reads the engine, and only migration-rpc.ts calls accept", async () => {
    // D34(c) exempts this file whole, and each dispatcher in it gets the ServerCtx carrying the
    // engine; a holder could pass `accept` its own consent, so pin where it is read and who calls it.
    const file = "packages/gateway/src/ipc/server/dispatchers/migration-rpcs.ts";
    const src = stripComments(await read(file));
    const reads = [...src.matchAll(/\bmigrationEngine\b/g)].map((m) => m.index ?? -1);
    expect(reads).toHaveLength(1);
    const fnAt = src.indexOf("export async function tryDispatchMigrationRpc(");
    expect(fnAt).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}\n", fnAt);
    expect(reads[0]).toBeGreaterThan(fnAt);
    expect(reads[0]).toBeLessThan(fnEnd);
    const acceptCallers = (await readDirFiles("packages/gateway/src"))
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) =>
        /\bengine\.accept\(|\bmigrationEngine\??\.accept\(/.test(stripComments(f.contents)),
      )
      .map((f) => f.rel);
    expect(acceptCallers).toEqual(["ipc/migration-rpc.ts"]);
  });

  test("assemble: no extension spawns until the boot verification pass ends; the gate resolves in its finally", async () => {
    const src = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    expect(src).toMatch(
      /try\s*\{\s*await verifyExtensionsBestEffort\([^;]*\);\s*\}\s*finally\s*\{\s*extensionSpawnGate\.resolve\(\);\s*\}/,
    );
    // Resolved nowhere else, and the mesh is handed the gate's promise.
    expect(src.match(/extensionSpawnGate\.resolve\(/g) ?? []).toHaveLength(1);
    expect(src).toContain("extensionSpawnGate: extensionSpawnGate.promise,");
  });

  test("assemble: createSchedulerWithMesh receives the runtime switch computed by isExtensionRuntimeEnabled", async () => {
    const src = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    const computeAt = src.indexOf("const extensionRuntimeEnabled = isExtensionRuntimeEnabled(");
    expect(computeAt).toBeGreaterThan(-1);
    const callAt = src.indexOf("await createSchedulerWithMesh({");
    expect(callAt).toBeGreaterThan(computeAt);
    const call = src.slice(callAt, src.indexOf("});", callAt));
    expect(call).toMatch(/\n\s*extensionRuntimeEnabled(?:: extensionRuntimeEnabled)?,\s*\n/);
    expect(call).not.toMatch(/extensionRuntimeEnabled:\s*(?:true|!|\()/);
  });
});
