import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import type { ServerCtx } from "./context.ts";
import { RpcMethodError } from "./rpc-error.ts";
import { dispatchVaultGated, rpcVaultOrMethodNotFound } from "./vault-dispatch.ts";

let vault: NimbusVault;

beforeEach(async () => {
  vault = createMockVault();
  await vault.set("github.pat", "ghp_test");
});

describe("dispatchVaultGated — vault.* method dispatch (gate disabled path)", () => {
  test("vault.get returns the stored value", async () => {
    const r = await dispatchVaultGated(vault, undefined, "vault.get", { key: "github.pat" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toBe("ghp_test");
  });

  test("vault.get for missing key returns null", async () => {
    const r = await dispatchVaultGated(vault, undefined, "vault.get", { key: "absent.key" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toBeNull();
  });

  test("vault.set persists a value", async () => {
    const r = await dispatchVaultGated(vault, undefined, "vault.set", {
      key: "slack.token",
      value: "xoxb-test",
    });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ ok: true });
    expect(await vault.get("slack.token")).toBe("xoxb-test");
  });

  test("vault.delete removes a key", async () => {
    const r = await dispatchVaultGated(vault, undefined, "vault.delete", { key: "github.pat" });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ ok: true });
    expect(await vault.get("github.pat")).toBeNull();
  });

  test("vault.listKeys returns sorted keys", async () => {
    await vault.set("slack.token", "x");
    const r = await dispatchVaultGated(vault, undefined, "vault.listKeys", {});
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    const keys = r.value as string[];
    expect(keys).toContain("github.pat");
    expect(keys).toContain("slack.token");
  });

  test("vault.listKeys filters by prefix", async () => {
    await vault.set("slack.token", "x");
    const r = await dispatchVaultGated(vault, undefined, "vault.listKeys", { prefix: "github." });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual(["github.pat"]);
  });

  test("vault.listKeys with undefined params returns all keys", async () => {
    const r = await dispatchVaultGated(vault, undefined, "vault.listKeys", undefined);
    expect(r.kind).toBe("hit");
  });

  test("unknown method returns miss", async () => {
    const r = await dispatchVaultGated(vault, undefined, "engine.ask", {});
    expect(r.kind).toBe("miss");
  });
});

describe("dispatchVaultGated — invalid params", () => {
  test("vault.set with non-record params -> -32602", async () => {
    await expect(dispatchVaultGated(vault, undefined, "vault.set", null)).rejects.toThrow(
      RpcMethodError,
    );
  });

  test("vault.set without value -> -32602", async () => {
    await expect(dispatchVaultGated(vault, undefined, "vault.set", { key: "x" })).rejects.toThrow(
      /Invalid params/,
    );
  });

  test("vault.set with non-string key -> -32602", async () => {
    await expect(
      dispatchVaultGated(vault, undefined, "vault.set", { key: 42, value: "v" }),
    ).rejects.toThrow(/Invalid params/);
  });

  test("vault.get without key -> -32602", async () => {
    await expect(dispatchVaultGated(vault, undefined, "vault.get", {})).rejects.toThrow(
      /Invalid params/,
    );
  });

  test("vault.delete with non-record -> -32602", async () => {
    await expect(dispatchVaultGated(vault, undefined, "vault.delete", "string")).rejects.toThrow(
      /Invalid params/,
    );
  });

  test("vault.set with malformed key -> -32602 'Invalid vault key format'", async () => {
    try {
      await dispatchVaultGated(vault, undefined, "vault.set", { key: "!!bad", value: "v" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
      expect((e as RpcMethodError).message).toContain("Invalid vault key format");
    }
  });

  test("vault.get with malformed key -> -32602 'Invalid vault key format'", async () => {
    await expect(
      dispatchVaultGated(vault, undefined, "vault.get", { key: "!!bad" }),
    ).rejects.toThrow(/Invalid vault key format/);
  });
});

function buildCtx(opts: { withLocalIndex: boolean; consentImpl?: ConsentCoordinatorImpl }): {
  ctx: ServerCtx;
  openDbs: unknown[];
} {
  const openDbs: unknown[] = [];
  const consentImpl = opts.consentImpl ?? new ConsentCoordinatorImpl(() => undefined);
  let localIndex: LocalIndex | undefined;
  if (opts.withLocalIndex) {
    const { Database } = require("bun:sqlite") as { Database: new (path: string) => unknown };
    const db = new Database(":memory:") as { close: () => void };
    LocalIndex.ensureSchema(db as never); // NOSONAR S4325: db is a minimal {close} stub widened to Database for the test
    localIndex = new LocalIndex(db as never); // NOSONAR S4325: db is a minimal {close} stub widened to Database for the test
    openDbs.push(db);
  }
  const ctx: ServerCtx = {
    options: {
      listenPath: "",
      vault,
      version: "test",
      ...(localIndex === undefined ? {} : { localIndex }),
    },
    consentImpl,
    startedAtMs: Date.now(),
    streamRegistry: { register: () => "id", complete: () => {}, error: () => {} } as never,
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
  return { ctx, openDbs };
}

describe("rpcVaultOrMethodNotFound", () => {
  afterEach(() => {
    /* DB cleanup deferred to per-test using openDbs */
  });

  test("unknown non-vault method -> -32601", async () => {
    const { ctx } = buildCtx({ withLocalIndex: false });
    try {
      await rpcVaultOrMethodNotFound(ctx, "engine.unknown", {}, "client-1");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
      expect((e as RpcMethodError).message).toContain("Method not found");
    }
  });

  test("vault.get hits without ToolExecutor when localIndex absent", async () => {
    const { ctx } = buildCtx({ withLocalIndex: false });
    const r = await rpcVaultOrMethodNotFound(ctx, "vault.get", { key: "github.pat" }, "client-1");
    expect(r).toBe("ghp_test");
  });

  test("vault.get with localIndex still bypasses gate (reads ungated)", async () => {
    const { ctx, openDbs } = buildCtx({ withLocalIndex: true });
    try {
      const r = await rpcVaultOrMethodNotFound(ctx, "vault.get", { key: "github.pat" }, "client-1");
      expect(r).toBe("ghp_test");
    } finally {
      for (const db of openDbs) (db as { close: () => void }).close();
    }
  });

  test("vault.listKeys returns sorted list", async () => {
    const { ctx } = buildCtx({ withLocalIndex: false });
    const r = await rpcVaultOrMethodNotFound(ctx, "vault.listKeys", {}, "client-1");
    expect(Array.isArray(r)).toBe(true);
    expect(r).toContain("github.pat");
  });
});

describe("rpcVaultOrMethodNotFound — the HITL gate's blocking contract (F16)", () => {
  /**
   * Every test above passes `undefined` for the ToolExecutor, so the gate never runs and the
   * blocking half of `vault.set` / `vault.delete` was never exercised. That half IS the
   * production behaviour: both methods are in the HITL frozen set (I2), `dispatchVaultGated`
   * awaits `toolExecutor.gate()` first, and `ConsentCoordinatorImpl.requestConsent` has no
   * timer — it settles on `consent.respond`, on client disconnect, and on nothing else.
   *
   * Pinning it here is what makes the CLI-side fake in `commands/vault.test.ts` honest: that
   * fake blocks until a `consent.request` is answered because THIS is what the real dispatcher
   * does, not because it seemed plausible.
   */
  function buildGatedCtx(): {
    ctx: ServerCtx;
    openDbs: unknown[];
    consentImpl: ConsentCoordinatorImpl;
    sent: Array<{ method: string; params: unknown }>;
  } {
    const sent: Array<{ method: string; params: unknown }> = [];
    const consentImpl = new ConsentCoordinatorImpl((clientId) =>
      clientId === "client-1"
        ? (n): void => {
            sent.push({ method: n.method, params: n.params });
          }
        : undefined,
    );
    const { ctx, openDbs } = buildCtx({ withLocalIndex: true, consentImpl });
    return { ctx, openDbs, consentImpl, sent };
  }

  /** Resolves to "pending" if `p` has not settled by the next few macrotasks. */
  async function settlesSoon(p: Promise<unknown>): Promise<"settled" | "pending"> {
    return Promise.race([
      p.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"pending">((r) => {
        setTimeout(() => r("pending"), 50);
      }),
    ]);
  }

  test("vault.set emits consent.request and does NOT settle until it is answered", async () => {
    const { ctx, openDbs, consentImpl, sent } = buildGatedCtx();
    try {
      const call = rpcVaultOrMethodNotFound(
        ctx,
        "vault.set",
        { key: "azure.tenant_id", value: "6875a760" },
        "client-1",
      );

      expect(await settlesSoon(call)).toBe("pending");
      expect(sent.map((n) => n.method)).toEqual(["consent.request"]);
      // Nothing is written while the owner has not answered.
      expect(await vault.get("azure.tenant_id")).toBeNull();

      const first = sent[0];
      if (first === undefined) throw new Error("no consent.request was emitted");
      const requestId = (first.params as { requestId: string }).requestId;
      expect(consentImpl.handleRespond("client-1", { requestId, approved: true })).toBeNull();

      await call;
      expect(await vault.get("azure.tenant_id")).toBe("6875a760");
    } finally {
      for (const db of openDbs) (db as { close: () => void }).close();
    }
  });

  test("an unanswered consent.request leaves vault.set pending and stores nothing", async () => {
    // The production symptom of F16, at its source: the CLI registered no `consent.request`
    // handler, so nobody ever called `consent.respond`, and the caller burned its own 30s
    // request timeout while the gateway sat here. The gateway is not at fault and does not
    // recover on its own — there is no timer to fire.
    const { ctx, openDbs, sent } = buildGatedCtx();
    try {
      const call = rpcVaultOrMethodNotFound(
        ctx,
        "vault.set",
        { key: "azure.tenant_id", value: "6875a760" },
        "client-1",
      );
      call.catch(() => {}); // the test ends with it still pending; do not trip an unhandled rejection

      expect(await settlesSoon(call)).toBe("pending");
      expect(sent).toHaveLength(1);
      expect(await vault.get("azure.tenant_id")).toBeNull();
    } finally {
      for (const db of openDbs) (db as { close: () => void }).close();
    }
  });

  test("a REFUSED consent leaves the vault untouched", async () => {
    const { ctx, openDbs, consentImpl, sent } = buildGatedCtx();
    try {
      const call = rpcVaultOrMethodNotFound(ctx, "vault.delete", { key: "github.pat" }, "client-1");
      expect(await settlesSoon(call)).toBe("pending");

      const first = sent[0];
      if (first === undefined) throw new Error("no consent.request was emitted");
      const requestId = (first.params as { requestId: string }).requestId;
      consentImpl.handleRespond("client-1", { requestId, approved: false });

      await expect(call).rejects.toBeInstanceOf(RpcMethodError);
      expect(await vault.get("github.pat")).toBe("ghp_test");
    } finally {
      for (const db of openDbs) (db as { close: () => void }).close();
    }
  });
});
