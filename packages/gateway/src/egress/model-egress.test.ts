import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "../llm/types.ts";
import { THIS_BINARY_COVERAGE } from "./egress-coverage.ts";
import { listEgress } from "./egress-verify.ts";
import { EgressAppendFailedError, wrapLedgeredProvider } from "./model-egress.ts";

// The REAL schema, via the migration runner -- the pattern every other `egress/*.test.ts`
// uses. `appendEgressEntry` calls `readHeadHash` and `dbRun` and computes a BLAKE3 chain
// over prior rows, so a hand-rolled CREATE TABLE would risk exercising something other
// than the code path that actually runs. Rows are read back with `listEgress`, which
// returns them camelCased.

// Carried over from `egress/synthesis-egress.test.ts`, which Task 3 DELETES. This is the
// only test pinning the `model` coverage class, and `nimbus prove` reports on it -- it must
// not vanish with its old home.
describe("model coverage", () => {
  test("model is per-call now that every non-local route appends", () => {
    expect(THIS_BINARY_COVERAGE.model).toBe("per-call");
  });
});

function makeProvider(
  providerId: string,
  isLocal: boolean,
): LlmProvider & {
  generate: ReturnType<typeof mock>;
} {
  const generate = mock(
    async (_opts: LlmGenerateOptions): Promise<LlmGenerateResult> => ({
      text: "ok",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "m",
      isLocal,
      provider: providerId,
    }),
  );
  return {
    providerId,
    isLocal,
    isAvailable: async () => true,
    listModels: async () => [],
    generate,
  } as LlmProvider & { generate: ReturnType<typeof mock> };
}

describe("wrapLedgeredProvider", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  test("a LOCAL provider is returned unchanged and appends nothing", async () => {
    // Identity, not a pass-through wrapper: a local generate makes no outbound request,
    // so ledgering it would over-claim egress the way an unfiltered
    // LOCAL_ONLY_SYNC_SERVICES did. Not even a blocked row.
    const inner = makeProvider("ollama", true);
    const wrapped = wrapLedgeredProvider(db, inner, "qwen3:8b");

    expect(wrapped).toBe(inner);

    await wrapped.generate({ task: "reasoning", prompt: "hi" });
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("a REMOTE provider appends exactly one row, destination = providerId", async () => {
    // #1321's lesson: "email" is not a place data can go, "gmail" is. The destination
    // must name the vendor, never the word "model".
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6", () => 1234);

    await wrapped.generate({ task: "reasoning", prompt: "hi" });

    const r = listEgress(db, {});
    expect(r).toHaveLength(1);
    expect(r[0]?.sourceType).toBe("model");
    expect(r[0]?.destination).toBe("anthropic");
    expect(r[0]?.sourceId).toBe("claude-sonnet-4-6");
    expect(r[0]?.method).toBe("llm.generate.reasoning");
    expect(r[0]?.timestamp).toBe(1234);
    expect(r[0]?.resultStatus).toBe("authorized");
  });

  test("egressMethod overrides the derived method", async () => {
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    await wrapped.generate({
      task: "reasoning",
      prompt: "hi",
      egressMethod: "agents.catchup.synthesis",
    });

    expect(listEgress(db, {})[0]?.method).toBe("agents.catchup.synthesis");
  });

  test("egressMethod cannot suppress a row for a remote provider", async () => {
    // The field names the row; it never decides whether one exists. Locality is derived
    // from the provider, so no caller can write a false zero into the ledger.
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    await wrapped.generate({ task: "reasoning", prompt: "hi", egressMethod: "" });

    expect(listEgress(db, {})).toHaveLength(1);
  });

  test("fail-closed: an append failure throws and the delegate never runs", async () => {
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");
    db.exec("DROP TABLE egress_ledger");

    await expect(wrapped.generate({ task: "reasoning", prompt: "hi" })).rejects.toBeInstanceOf(
      EgressAppendFailedError,
    );
    expect(inner.generate).toHaveBeenCalledTimes(0);
  });

  test("the wrapper is a faithful proxy of providerId and isLocal", async () => {
    // `byPreference`, `reasonFor`, `getStatus` and `ipc/llm-rpc.ts` all read these off the
    // route's provider. A wrapper that dropped or inverted them would silently re-sort the
    // priority walk and mislabel every status row.
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    expect(wrapped.providerId).toBe("anthropic");
    expect(wrapped.isLocal).toBe(false);
    expect(await wrapped.isAvailable()).toBe(true);
    expect(await wrapped.listModels()).toEqual([]);
  });

  test("an OPTIONAL pullModel is forwarded, and bound to the inner provider", async () => {
    // The conditional spread has two arms and the tests above only ever exercised the absent
    // one. This matters beyond coverage: `pullModel` is `.bind`-ed rather than arrow-wrapped,
    // so a regression to a bare `provider.pullModel` reference would lose `this` and throw
    // only at pull time, on a multi-gigabyte download.
    let pulledBy: unknown;
    let pulledName = "";
    const inner = {
      ...makeProvider("anthropic", false),
      pullModel(this: unknown, modelName: string): Promise<void> {
        pulledBy = this;
        pulledName = modelName;
        return Promise.resolve();
      },
    };
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    expect(wrapped.pullModel).toBeDefined();
    await wrapped.pullModel?.("claude-sonnet-4-6", {});
    expect(pulledName).toBe("claude-sonnet-4-6");
    expect(pulledBy).toBe(inner);
    // Pulling is not egress the ledger claims: only `generate` appends.
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("a provider WITHOUT pullModel does not gain an undefined one", () => {
    // The other arm. A `pullModel: undefined` key is not the same as an absent key under
    // `exactOptionalPropertyTypes`, and `LlmRegistry.pullModel` tests `typeof !== "function"`.
    const wrapped = wrapLedgeredProvider(db, makeProvider("anthropic", false), "m");
    expect("pullModel" in wrapped).toBe(false);
  });

  test("wrapping is idempotent-safe: re-wrapping an already-wrapped provider double-counts", async () => {
    // Documents WHY `addRoute` wraps and `registerRoute` does not (Task 3). If a future
    // change moved the wrap into `registerRoute`, `refreshProviderMeta`'s re-registration
    // would wrap the wrapper and every generate would append twice. This test pins the
    // hazard so that change fails loudly here rather than silently in the ledger.
    const inner = makeProvider("anthropic", false);
    const once = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");
    const twice = wrapLedgeredProvider(db, once, "claude-sonnet-4-6");

    await twice.generate({ task: "reasoning", prompt: "hi" });
    expect(listEgress(db, {})).toHaveLength(2);
  });
});
