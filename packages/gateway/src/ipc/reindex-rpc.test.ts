import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ToolExecutor } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchReindexRpc, ReindexRpcError } from "./reindex-rpc.ts";

function makeIdx(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

type GateOutcome = "proceed" | { status: "rejected"; reason: string };

function makeFakeExecutor(opts?: {
  outcome?: GateOutcome;
  onGate?: (action: PlannedAction) => void;
}): ToolExecutor {
  const outcome: GateOutcome = opts?.outcome ?? "proceed";
  return {
    gate: async (action: PlannedAction) => {
      opts?.onGate?.(action);
      return outcome;
    },
  } as unknown as ToolExecutor;
}

describe("dispatchReindexRpc", () => {
  test("returns miss for non-reindex method", async () => {
    const out = await dispatchReindexRpc("foo.bar", {}, { index: makeIdx() });
    expect(out.kind).toBe("miss");
  });

  test("connector.reindex forwards to reindexConnector", async () => {
    const idx = makeIdx();
    const out = await dispatchReindexRpc(
      "connector.reindex",
      { service: "github", depth: "metadata_only" },
      { index: idx },
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const value = out.value as { itemsAffected: number };
      expect(value.itemsAffected).toBe(0);
    }
  });

  test("throws ReindexRpcError when service param missing", async () => {
    const idx = makeIdx();
    await expect(
      dispatchReindexRpc("connector.reindex", { depth: "metadata_only" }, { index: idx }),
    ).rejects.toBeInstanceOf(ReindexRpcError);
  });

  for (const depth of ["metadata_only", "summary"] as const) {
    test(`${depth} depth skips the HITL gate (administrative)`, async () => {
      let gateCalls = 0;
      const idx = makeIdx();
      const executor = makeFakeExecutor({ onGate: () => gateCalls++ });
      const out = await dispatchReindexRpc(
        "connector.reindex",
        { service: "github", depth },
        { index: idx, toolExecutor: executor },
      );
      expect(gateCalls).toBe(0);
      expect(out.kind).toBe("hit");
    });
  }

  test("full depth runs the HITL gate before reindex", async () => {
    const order: string[] = [];
    const idx = makeIdx();
    const executor = makeFakeExecutor({
      onGate: (action) => {
        order.push("gate");
        expect(action.type).toBe("connector.reindex");
        const payload = action.payload;
        expect(payload?.["service"]).toBe("github");
        expect(payload?.["depth"]).toBe("full");
      },
    });
    const out = await dispatchReindexRpc(
      "connector.reindex",
      { service: "github", depth: "full" },
      { index: idx, toolExecutor: executor },
    );
    order.push("after-dispatch");
    expect(order).toEqual(["gate", "after-dispatch"]);
    expect(out.kind).toBe("hit");
  });

  test("full depth bypasses the gate when no toolExecutor is wired (internal callers)", async () => {
    const idx = makeIdx();
    const out = await dispatchReindexRpc(
      "connector.reindex",
      { service: "github", depth: "full" },
      { index: idx },
    );
    expect(out.kind).toBe("hit");
  });

  test("full depth declined consent throws ReindexRpcError", async () => {
    const idx = makeIdx();
    const executor = makeFakeExecutor({
      outcome: { status: "rejected", reason: "User declined consent gate." },
    });
    await expect(
      dispatchReindexRpc(
        "connector.reindex",
        { service: "github", depth: "full" },
        { index: idx, toolExecutor: executor },
      ),
    ).rejects.toBeInstanceOf(ReindexRpcError);
  });
});
