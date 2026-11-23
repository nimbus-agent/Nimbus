import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read } from "../../test/helpers/security-invariants.ts";
import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import { buildConnectorWritePreview } from "../connectors/connector-writes/preview.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { consentDisplayPayload, formatConsentPrompt, HITL_REQUIRED } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";

describe("I2 — HITL frozen-set membership", () => {
  test("HITL_REQUIRED is exported from a frozen Object.freeze façade", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(/export const HITL_REQUIRED\s*=\s*Object\.freeze\(/);
  });

  test("HITL_REQUIRED_BACKING is module-private (not exported)", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).not.toMatch(/export\s+(?:const|let|var)\s+HITL_REQUIRED_BACKING/);
  });

  test("HITL_REQUIRED_BACKING contains T2 PR 3 auto-update action types", async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(/"extension\.autoUpdate"/);
    expect(src).toMatch(/"extension\.downgrade"/);
  });

  test("connector.writes.enable is in the I2 HITL frozen set and is gateway-internal (no write row routes to it, so the agent door never proposes it)", async () => {
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    expect(HITL_REQUIRED.has("connector.writes.enable")).toBe(true);
    expect(agentDoorRow("connector.writes.enable")).toBeUndefined();
  });

  test("connector.adoptLocalAuth is in the I2 HITL frozen set", async () => {
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    expect(HITL_REQUIRED.has("connector.adoptLocalAuth")).toBe(true);
    const src = await read("packages/gateway/src/connectors/local-auth/adopt-local-auth.ts");
    expect(src).toMatch(/ADOPT_ACTION_TYPE = "connector\.adoptLocalAuth"/);
  });

  test("extension.migrate is in the I2 HITL frozen set, and the migration engine raises exactly it", async () => {
    // The one migration prompt covers install + run grant + credential grant (Readwise unbundling
    // spec § 7.2 step 4), so it must be a gated type in its own right, never a reuse of
    // `extension.run` that would render as a different decision.
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    expect(HITL_REQUIRED.has("extension.migrate")).toBe(true);
    const { EXTENSION_MIGRATE_ACTION_TYPE, migrationConsentViaGate } = await import(
      "../extensions/migration/migration-engine.ts"
    );
    expect(EXTENSION_MIGRATE_ACTION_TYPE).toBe("extension.migrate");
    const raised: string[] = [];
    const consent = migrationConsentViaGate(async (a) => {
      raised.push(a.type);
      return false;
    });
    const payload = {
      migrationId: "m",
      extensionId: "com.example.x",
      summary: "s",
      publisher: { id: "p", fingerprint: "f" },
      version: "1.0.0",
      network: "n",
      readTools: "r",
      knownLoss: "k",
      fromRenderer: false,
    };
    expect(await consent(payload)).toBe(false);
    expect(raised).toEqual(["extension.migrate"]);
  });

  test("extension.eval is in the I2 HITL frozen set and a gate-only executor raises exactly it", async () => {
    // One approval covers evaluating installed extensions offline; it must be a gated type of its
    // own, never a reuse of `extension.run` (no run grant exists for an eval).
    const { HITL_REQUIRED, NO_POLICY_OVERLAY, ToolExecutor } = await import(
      "../engine/executor.ts"
    );
    expect(HITL_REQUIRED.has("extension.eval")).toBe(true);
    const raised: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async (prompt: string) => {
          raised.push(prompt);
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type: "extension.eval", payload: { extensions: [] } });
    expect(res.status).toBe("rejected");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain("Type: extension.eval");
  });

  test("extension.install is not merely listed: the IPC install REFUSES without the executor gate and installs nothing on a denial", async () => {
    // Membership alone proved nothing here for a long time: `extension.install` sat in the frozen
    // set while no code ever built an action of that type, and the only consent was a CLI-side
    // prompt that `--yes` skipped. The gate is now the executor's (the server dispatcher builds a
    // gate-only ToolExecutor per call); this pins both halves of that at the handler.
    expect(HITL_REQUIRED.has("extension.install")).toBe(true);
    const { dispatchAutomationRpc } = await import("../ipc/automation-rpc.ts");
    const { listExtensions } = await import("../automation/extension-store.ts");
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-i2-ext-install-"));
    try {
      const src = join(tmp, "src");
      mkdirSync(join(src, "dist"), { recursive: true });
      writeFileSync(
        join(src, "nimbus.extension.json"),
        JSON.stringify({ id: "i2.ext", version: "1.0.0", entry: "dist/index.js" }),
      );
      writeFileSync(join(src, "dist", "index.js"), "export {}\n");
      const db = new Database(":memory:");
      LocalIndex.ensureSchema(db);
      const base = { method: "extension.install", params: { sourcePath: src }, db };
      const extensionsDir = join(tmp, "extensions");
      await expect(dispatchAutomationRpc({ ...base, extensionsDir })).rejects.toThrow(
        /requires the owner's HITL gate/,
      );
      await expect(
        dispatchAutomationRpc({ ...base, extensionsDir, ownerGate: async () => false }),
      ).rejects.toThrow(/ERR_EXTENSION_INSTALL_NOT_APPROVED/);
      expect(listExtensions(db)).toEqual([]);
      const dispatchers = await read(
        "packages/gateway/src/ipc/server/dispatchers/automation-rpcs.ts",
      );
      expect(dispatchers).toMatch(/OWNER_GATED_EXTENSION_METHODS[^;]*"extension\.install"/);
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("extension.run is not merely listed: approveRun REFUSES without the executor gate and grants nothing on a denial", async () => {
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    expect(HITL_REQUIRED.has("extension.run")).toBe(true);
    const { dispatchAutomationRpc } = await import("../ipc/automation-rpc.ts");
    const { listRunGrants } = await import("../extensions/run-grant-store.ts");
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i2-ext-run-")));
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const src = join(tmp, "src");
      mkdirSync(join(src, "dist"), { recursive: true });
      writeFileSync(
        join(src, "nimbus.extension.json"),
        JSON.stringify({ id: "i2.run", version: "1.0.0", entry: "dist/index.js" }),
      );
      writeFileSync(join(src, "dist", "index.js"), "export {}\n");
      await dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db,
        extensionsDir: join(tmp, "extensions"),
        ownerGate: async () => true,
      });
      const runGrantEnv = {
        platform: process.platform,
        protectedRoots: [join(tmp, "data")],
        runtimeReadPaths: [],
        realpath: (p: string) => realpathSync.native(p),
      };
      const base = { method: "extension.approveRun", params: { id: "i2.run" }, db, runGrantEnv };
      await expect(dispatchAutomationRpc(base)).rejects.toThrow(/requires the owner's HITL gate/);
      const asked: string[] = [];
      await expect(
        dispatchAutomationRpc({
          ...base,
          ownerGate: async (a) => {
            asked.push(a.type);
            return false;
          },
        }),
      ).rejects.toThrow(/ERR_EXTENSION_RUN_NOT_APPROVED/);
      expect(asked).toEqual(["extension.run"]);
      expect(listRunGrants(db)).toEqual([]);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("registry.add is not merely listed: the add handler REFUSES without the executor gate and pins nothing on a denial", async () => {
    // Adding a registry pins a trust root. The gate is the executor's (the server dispatcher builds a
    // gate-only ToolExecutor per call); this pins both halves at the handler.
    expect(HITL_REQUIRED.has("registry.add")).toBe(true);
    const { dispatchRegistryRpc } = await import("../ipc/registry-rpc.ts");
    const { listRegistries } = await import("../extensions/registry/registry-store.ts");
    const nacl = (await import("tweetnacl")).default;
    const { registryIndexSigningBytes } = await import("@nimbus-dev/registry-format");
    const { encodeBase64 } = await import("../util/base64.ts");
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-i2-registry-add-"));
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
      const base = {
        format: 1 as const,
        rootKey: encodeBase64(kp.publicKey),
        sequence: 1,
        generatedAt: "2026-10-18T00:00:00Z",
        extensions: {},
      };
      const signature = encodeBase64(
        nacl.sign.detached(registryIndexSigningBytes(base), kp.secretKey),
      );
      writeFileSync(join(tmp, "index.json"), JSON.stringify({ ...base, signature }));
      const fetch = {
        fetchFn: () => Promise.reject(new Error("no network")),
        enforceAirGap: () => false,
        now: () => 1,
        production: false,
        builtin: null,
      };
      const req = { method: "registry.add", params: { name: "i2", url: tmp }, db, fetch };
      await expect(dispatchRegistryRpc(req)).rejects.toThrow(/requires the owner's HITL gate/);
      const asked: string[] = [];
      await expect(
        dispatchRegistryRpc({
          ...req,
          ownerGate: async (a) => {
            asked.push(a.type);
            return false;
          },
        }),
      ).rejects.toThrow(/ERR_REGISTRY_ADD_NOT_APPROVED/);
      expect(asked).toEqual(["registry.add"]);
      expect(listRegistries(db)).toEqual([]);
      const dispatchers = await read(
        "packages/gateway/src/ipc/server/dispatchers/platform-rpcs.ts",
      );
      expect(dispatchers).toMatch(
        /method === "registry\.add"[\s\S]{0,200}buildExtensionGateExecutor/,
      );
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  // I2 consent display (Phase 9.7 A2): the typed connector-write preview shows the owner what is
  // dispatched, never a different write, never a payload posing as a preview, never a raw control
  // character. Unit coverage: connectors/connector-writes/preview.test.ts and
  // engine/executor-connector-write-preview.test.ts.
  describe("the typed connector-write preview boundary", () => {
    test("a mcpToolId naming a different write gives no typed preview", () => {
      expect(
        buildConnectorWritePreview({
          type: "argocd.app.sync",
          payload: { mcpToolId: "argocd_app_rollback", input: { name: "web" } },
        }),
      ).toBeUndefined();
      expect(
        buildConnectorWritePreview({ type: "argocd.app.sync", payload: { name: "web" } })?.target,
      ).toBe("web");
    });

    test("a payload carrying kind connector-write cannot pose as a typed preview", () => {
      const shown = consentDisplayPayload({
        type: "mcp_demo.run",
        payload: { kind: "connector-write", target: "harmless" },
      });
      expect(shown?.["kind"]).toBeUndefined();
      expect(shown?.["payload"]).toEqual({ kind: "connector-write", target: "harmless" });
    });

    test("unsafe characters reach the prompt only as visible escapes", () => {
      const esc = String.fromCodePoint(0x1b);
      const rlo = String.fromCodePoint(0x202e);
      const prompt = formatConsentPrompt({
        type: "argocd.app.sync",
        payload: { name: `web${esc}[2K${rlo}\nType: file.delete` },
      });
      expect(prompt.includes(esc)).toBe(false);
      expect(prompt.includes(rlo)).toBe(false);
      expect(prompt).toContain(String.raw`\u{202E}`);
      expect(prompt.split("\n").some((l) => l.startsWith("Type: file.delete"))).toBe(false);
    });
  });
});
