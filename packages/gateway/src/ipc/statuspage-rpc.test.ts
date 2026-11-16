import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import type { StatuspageModel } from "../statuspage/statuspage-model.ts";
import { createMockVault } from "../vault/mock.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { createStreamRegistry } from "./engine-ask-stream.ts";
import { phase4RpcSkipped, type ServerCtx } from "./server/context.ts";
import { tryDispatchPhase4Rpc, tryDispatchStatuspageRpc } from "./server/dispatchers.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { dispatchStatuspageRpc, StatuspageRpcError } from "./statuspage-rpc.ts";

const NOW = Date.UTC(2026, 10, 16, 9, 0);
const origFetch = globalThis.fetch;

let db: Database;
let dir: string;
beforeEach(() => {
  db = createMemoryIndexDb();
  dir = mkdtempSync(join(tmpdir(), "nimbus-statuspage-"));
  globalThis.fetch = (() => {
    throw new Error("statuspage.model must never make a network call");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  params: unknown,
  over: { configDir?: string; warn?: (m: string) => void } = {},
): Promise<StatuspageModel> {
  const out = await dispatchStatuspageRpc("statuspage.model", params, {
    db,
    now: () => NOW,
    warn: over.warn ?? (() => {}),
    ...(over.configDir === undefined ? {} : { configDir: over.configDir }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value as StatuspageModel;
}

describe("statuspage.model", () => {
  test("answers an empty index with the no-data statuses and makes no network call", async () => {
    const m = await call(undefined);
    expect(m.incidents.status).toBe("no_data");
    expect(m.generatedAtMs).toBe(NOW);
    expect(m.options).toEqual({ services: [], titles: false, links: false });
  });

  test("reads service configs from the config dir", async () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[metrics.dora.payments]\nrepos = ["github:acme/payments"]\npagerduty_services = ["PSVC1"]\n',
    );
    const m = await call({ services: ["payments"], titles: true }, { configDir: dir });
    expect(m.dora.rows.map((r) => r.service)).toEqual(["payments"]);
    expect(m.options.titles).toBe(true);
    expect(JSON.stringify(m)).not.toContain("acme/payments");
  });

  test("a malformed config degrades to a stated gap, with a warning", async () => {
    writeFileSync(join(dir, "nimbus.toml"), '[metrics.dora.x]\nrepos = ["nonsense"]\n');
    const warnings: string[] = [];
    const m = await call({}, { configDir: dir, warn: (w) => warnings.push(w) });
    expect(m.dora.status).toBe("config_error");
    expect(warnings).toHaveLength(1);
  });

  test("other methods miss", async () => {
    const out = await dispatchStatuspageRpc("statuspage.zzz", {}, { db });
    expect(out.kind).toBe("miss");
  });

  test.each([
    [5, "requires an object"],
    [[], "requires an object"],
    [{ extra: 1 }, "unknown parameter"],
    [{ titles: "yes" }, "titles must be a boolean"],
    [{ links: 1 }, "links must be a boolean"],
    [{ services: "a" }, "services must be an array"],
    [{ services: [""] }, "non-empty string"],
    [{ services: [5] }, "non-empty string"],
    [{ services: Array.from({ length: 21 }, () => "a") }, "at most 20"],
    [{ services: ["x".repeat(200)] }, "non-empty string"],
  ])("rejects %j with -32602", async (params, text) => {
    const err = await call(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatuspageRpcError);
    expect((err as StatuspageRpcError).rpcCode).toBe(-32602);
    expect((err as Error).message).toContain(text);
  });
});

function makeCtx(withIndex: boolean): ServerCtx {
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(withIndex ? { localIndex: { getDatabase: () => db } } : {}),
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  } as unknown as ServerCtx;
}

describe("tryDispatchStatuspageRpc", () => {
  test("is answered through the phase 4 group", async () => {
    const out = (await tryDispatchPhase4Rpc(makeCtx(true), "statuspage.model", {}, "c1")) as {
      incidents: { status: string };
    };
    expect(out.incidents.status).toBe("no_data");
  });

  test("other methods and a missing index are skipped", async () => {
    expect(await tryDispatchStatuspageRpc(makeCtx(true), "statuspage.zzz", {})).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchStatuspageRpc(makeCtx(false), "statuspage.model", {})).toBe(
      phase4RpcSkipped,
    );
  });

  test("a validation error keeps its code", async () => {
    const err = await tryDispatchStatuspageRpc(makeCtx(true), "statuspage.model", {
      titles: 3,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32602);
  });
});
