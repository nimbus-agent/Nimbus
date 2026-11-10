// packages/gateway/src/connectors/connector-write-dispatch-iac.test.ts
// D2 whole-branch review finding 1: the PRODUCTION dispatcher chain (the one gateway-main, ChatOps
// and the MCP act door build) must keep the bound-write capabilities `createConnectorDispatcher`
// attaches. Every earlier test used a fake dispatcher, so the wrapper that dropped them shipped.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { PREPARE_REFUSALS } from "../engine/prepare-step.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { createMockVault } from "../vault/mock.ts";
import { createConnectorWriteDispatcher } from "./connector-write-dispatch.ts";
import { LazyConnectorMesh } from "./lazy-mesh/mesh.ts";
import { createConnectorDispatcher, meshDispatcherClient } from "./registry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function realMesh(): LazyConnectorMesh {
  const root = mkdtempSync(join(tmpdir(), "nimbus-wd-iac-"));
  roots.push(root);
  const paths: PlatformPaths = {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "cache", "sandbox"),
  };
  return new LazyConnectorMesh(paths, createMockVault());
}

const writeDeps = {
  vault: {} as never,
  sandboxCwd: tmpdir(),
  isConnectorAllowed: () => true,
  credentialFor: () => ({ credential: "personal" as const }),
  runTeamInvoke: async () => ({}),
};

function productionChain() {
  return createConnectorWriteDispatcher(
    createConnectorDispatcher(meshDispatcherClient(realMesh())),
    writeDeps,
  );
}

describe("the production write-dispatcher chain keeps the bound-write capabilities", () => {
  test("the wrapped dispatcher still carries them", () => {
    expect(productionChain().boundWriteCapabilities).toBeDefined();
  });

  test("a wrapper over a dispatcher with none still has none", () => {
    const d = createConnectorWriteDispatcher({ dispatch: async () => ({}) }, writeDeps);
    expect(d.boundWriteCapabilities).toBeUndefined();
  });

  test("through the executor, an iac apply reaches the runner's preflight, not capabilityMissing", async () => {
    const exec = new ToolExecutor(
      {
        requestApproval: async () => ({ approved: true, answerSource: "human" as const }),
        requestConfirmedApproval: async (req) => ({
          approved: true,
          typed: req.confirmText,
          answerSource: "human" as const,
        }),
      },
      { recordAudit: () => undefined },
      productionChain(),
      undefined,
      { append: () => undefined },
      NO_POLICY_OVERLAY,
    );
    const r = await exec.execute({
      type: "iac.terraform.apply",
      payload: {
        mcpToolId: "iac_iac_terraform_apply",
        input: { workingDirectory: join(tmpdir(), "nimbus-not-approved") },
      },
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).not.toBe(PREPARE_REFUSALS.capabilityMissing);
  });
});
