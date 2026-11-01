/**
 * The consent prompts state the sandbox's live reach, and the runner has to GET there: a wiring gap
 * in the dispatcher would leave it undefined and print "not known here" on every machine. These
 * go through the real `tryDispatch*` functions and the real executor gate, and read the prompt the
 * owner would be shown.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReachRunner } from "../../extensions/extension-reach.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { dispatchAutomationRpc } from "../automation-rpc.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ServerCtx } from "./context.ts";
import { tryDispatchAutomationRpc, tryDispatchConnectorRpc } from "./dispatchers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function runner(opts: {
  platform: "linux" | "darwin" | "win32";
  fullyActive: boolean;
  scope?: "per_port" | "all_or_nothing";
  reason: string | null;
}): NonNullable<ServerCtx["options"]["sandboxRunner"]> {
  const { scope } = opts;
  const r: ReachRunner = {
    platform: opts.platform,
    isFullyActive: () => opts.fullyActive,
    degradedReason: () => opts.reason,
    ...(scope === undefined ? {} : { networkScope: () => scope }),
    canConfine: () => null,
  };
  // Only the reach slice is read; `spawn` is never called on the prompt path.
  return r as unknown as NonNullable<ServerCtx["options"]["sandboxRunner"]>;
}

/** A ctx whose consent channel records each prompt and declines it (nothing is stored). */
function ctxWith(overrides: Partial<ServerCtx["options"]>, prompts: string[]): ServerCtx {
  const consentImpl: ConsentCoordinatorImpl = new ConsentCoordinatorImpl(() => (n) => {
    const p = n.params as { requestId: string; prompt: string };
    prompts.push(p.prompt);
    queueMicrotask(() =>
      consentImpl.handleRespond("c1", { requestId: p.requestId, approved: false }),
    );
  });
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

function mkIndex(): { db: Database; localIndex: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => db.close());
  return { db, localIndex: new LocalIndex(db) };
}

describe("the runner reaches the consent prompts through the real dispatch", () => {
  test("the run approval receives the runner through the real dispatch", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-reach-run-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { db, localIndex } = mkIndex();
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "reach.run",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: { network: ["a.com"] },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const extensionsDir = join(root, "data", "extensions");
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db,
      extensionsDir,
      ownerGate: async () => true,
    });
    const prompts: string[] = [];
    const ctx = ctxWith(
      {
        localIndex,
        extensionsDir,
        connectorMesh: { userMcpProtectedRoots: () => [join(root, "data")] } as never,
        sandboxRunner: runner({ platform: "linux", fullyActive: false, reason: "helper missing" }),
      },
      prompts,
    );
    await tryDispatchAutomationRpc(ctx, "c1", {} as never, "extension.approveRun", {
      id: "reach.run",
    }).catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("the whole network");
    expect(prompts[0]).not.toContain("not known here");
  });

  test("the add --mcp prompt receives the runner through the real dispatch", async () => {
    const { localIndex } = mkIndex();
    const prompts: string[] = [];
    const ctx = ctxWith(
      {
        localIndex,
        syncScheduler: { register: () => {} } as never,
        connectorMesh: {
          ensureUserMcpRunning: async () => {},
          userMcpProtectedRoots: () => [],
          ensureUserMcpSandboxClean: async () => {},
          userMcpSandboxLeaf: () => "",
        } as never,
        sandboxRunner: runner({
          platform: "win32",
          fullyActive: true,
          scope: "all_or_nothing",
          reason: null,
        }),
      },
      prompts,
    );
    await tryDispatchConnectorRpc(
      ctx,
      "connector.addMcp",
      { serviceId: "mcp_reach", argv: [process.execPath], netHosts: ["a.com"] },
      "c1",
    ).catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Windows cannot limit");
    expect(prompts[0]).not.toContain("not known here");
  });
});
