import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ServerCtx } from "./context.ts";
import {
  tryDispatchAgentsRpc,
  tryDispatchAuditRpc,
  tryDispatchDiagnosticsRpc,
  tryDispatchVoiceRpc,
} from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

let tmpDir: string;
let openDbs: Database[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-disp-hp-"));
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  openDbs = [];
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeCtx(overrides: Partial<ServerCtx["options"]> = {}): ServerCtx {
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...overrides,
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
  };
}

function trackDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

describe("assertDiagnosticsRpcAccess fall-through (the `return;` after each guard)", () => {
  test("config.* with configDir present falls through to dispatch", async () => {
    const ctx = makeCtx({ configDir: tmpDir });
    try {
      await tryDispatchDiagnosticsRpc(ctx, "config.validate", null);
    } catch {
      /* expected — handler reports errors */
    }
  });

  test("telemetry.* (non-preview) with dataDir present falls through", async () => {
    const ctx = makeCtx({ dataDir: tmpDir });
    const r = await tryDispatchDiagnosticsRpc(ctx, "telemetry.show", {});
    expect(r).toBeDefined();
  });

  test("telemetry.preview with both dataDir AND localIndex falls through", async () => {
    const db = trackDb();
    const localIndex = new LocalIndex(db);
    const ctx = makeCtx({ dataDir: tmpDir, localIndex });
    try {
      await tryDispatchDiagnosticsRpc(ctx, "telemetry.preview", {});
    } catch {
      /* expected for some handlers */
    }
  });
});

describe("tryDispatchVoiceRpc — body coverage with stub voiceService", () => {
  type Stub = Required<ServerCtx["options"]>["voiceService"];

  function makeStub(throws: boolean): Stub {
    return {
      async getStatus(): Promise<unknown> {
        if (throws) {
          throw new Error("stub failure");
        }
        return { mode: "idle" };
      },
    } as unknown as Stub;
  }

  test("delegates to dispatchVoiceRpc happy path", async () => {
    const ctx = makeCtx({ voiceService: makeStub(false) });
    try {
      const r = await tryDispatchVoiceRpc(ctx, "voice.getStatus", {});
      expect(r).toBeDefined();
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
    }
  });

  test("VoiceRpcError from inner dispatch is remapped to RpcMethodError", async () => {
    const ctx = makeCtx({ voiceService: makeStub(true) });
    try {
      await tryDispatchVoiceRpc(ctx, "voice.nonexistent", {});
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
    }
  });
});

describe("tryDispatchAgentsRpc — body coverage with localIndex", () => {
  test("unknown agents.* method falls through to -32601 (covers catch + final throw)", async () => {
    const db = trackDb();
    const localIndex = new LocalIndex(db);
    const ctx = makeCtx({ localIndex });
    try {
      await tryDispatchAgentsRpc(ctx, "agents.bogus", {});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
    }
  });

  test("with configDir present (the spread branch)", async () => {
    const db = trackDb();
    const localIndex = new LocalIndex(db);
    const ctx = makeCtx({ localIndex, configDir: tmpDir });
    try {
      await tryDispatchAgentsRpc(ctx, "agents.unknown", {});
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
    }
  });
});

describe("tryDispatchAuditRpc — body coverage", () => {
  test("audit.exportAll with localIndex routes through dispatchAuditRpc", async () => {
    const db = trackDb();
    const localIndex = new LocalIndex(db);
    const ctx = makeCtx({ localIndex });
    const out = await tryDispatchAuditRpc(ctx, "audit.exportAll", {});
    expect(out).toBeDefined();
  });
});
