/** Refusals of `automation-rpc.ts` that need no installed extension: missing wiring and unknown ids. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function indexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

async function failure(
  method: string,
  params: unknown,
  extra: object = {},
): Promise<AutomationRpcError> {
  const e = await dispatchAutomationRpc({ method, params, db: indexDb(), ...extra }).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AutomationRpcError);
  return e as AutomationRpcError;
}

describe("extension.audit", () => {
  test("lists every extension when no id is given, and refuses an unknown or non-string id", async () => {
    const out = await dispatchAutomationRpc({
      method: "extension.audit",
      params: {},
      db: indexDb(),
    });
    expect(out.kind).toBe("hit");
    const unknown = await failure("extension.audit", { id: "com.example.nope" });
    expect(unknown).toMatchObject({ rpcCode: -32602, message: "Extension not found" });
    const bad = await failure("extension.audit", { id: 5 });
    expect(bad.message).toBe("Missing or invalid id");
  });
});

describe("extension credentials without a Vault", () => {
  test("credentialStatus and credentialSet refuse an unwired gateway before looking at the extension", async () => {
    const status = await failure("extension.credentialStatus", { id: "com.example.a" });
    expect(status).toMatchObject({ rpcCode: -32603 });
    expect(status.message).toContain("requires the Vault");
  });

  test("credentialStatus of an extension that is not installed is refused", async () => {
    const e = await failure(
      "extension.credentialStatus",
      { id: "com.example.a" },
      { vault: { get: async () => null } },
    );
    expect(e).toMatchObject({ rpcCode: -32602, message: "Extension not found" });
  });
});

describe("extension.rehash and extension.eval wiring", () => {
  test("rehash needs the owner gate, then an installed extension", async () => {
    const noGate = await failure("extension.rehash", { id: "com.example.a" });
    expect(noGate.message).toContain("requires the owner's HITL gate");
    const missing = await failure(
      "extension.rehash",
      { id: "com.example.a" },
      { ownerGate: async () => true },
    );
    expect(missing).toMatchObject({ rpcCode: -32602, message: "Extension not found" });
  });

  test("eval refuses when the runtime is off, and when it is not fully wired", async () => {
    const off = await failure(
      "extension.eval",
      { ids: ["com.example.a"] },
      { extensionsRuntimeEnabled: false },
    );
    expect(off.message).toContain("ERR_EXTENSION_EVAL_RUNTIME_DISABLED");
    const unwired = await failure("extension.eval", { ids: ["com.example.a"] });
    expect(unwired.message).toContain("extension.eval requires the owner's HITL gate");
  });
});
