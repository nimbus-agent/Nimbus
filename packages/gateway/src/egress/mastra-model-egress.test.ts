import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listEgress } from "./egress-verify.ts";
import { wrapLedgeredMastraModel } from "./mastra-model-egress.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

function fakeModel(onCall: () => void) {
  return {
    specificationVersion: "v2" as const,
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      onCall();
      return { content: [] };
    },
    doStream: async () => {
      onCall();
      return { stream: new ReadableStream() };
    },
  };
}

describe("wrapLedgeredMastraModel", () => {
  test("doGenerate appends exactly one model row, destination = providerId", async () => {
    const wrapped = wrapLedgeredMastraModel(
      db,
      fakeModel(() => undefined),
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        now: () => 1234,
      },
    );
    await wrapped.doGenerate();

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "model",
      sourceId: "claude-sonnet-4-6",
      destination: "anthropic",
      method: "engine.agent.generate",
      resultStatus: "authorized",
    });
    expect(rows[0]?.timestamp).toBe(1234);
  });

  test("doStream appends its own row, named distinctly", async () => {
    const wrapped = wrapLedgeredMastraModel(
      db,
      fakeModel(() => undefined),
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    );
    await wrapped.doStream();
    expect(listEgress(db, {})[0]?.method).toBe("engine.agent.stream");
  });

  test("fail-closed: an append failure throws and the inner model never runs", async () => {
    let called = false;
    const wrapped = wrapLedgeredMastraModel(
      db,
      fakeModel(() => {
        called = true;
      }),
      { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
    );
    db.exec("DROP TABLE egress_ledger");

    await expect(wrapped.doGenerate()).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("passes through the identity fields Mastra reads", () => {
    const wrapped = wrapLedgeredMastraModel(
      db,
      fakeModel(() => undefined),
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    );
    expect(wrapped.specificationVersion).toBe("v2");
    expect(wrapped.provider).toBe("anthropic");
    expect(wrapped.modelId).toBe("claude-sonnet-4-6");
  });

  test("pass-through works against a REAL ModelRouterLanguageModel, not just the fake", () => {
    // The fake above has NO `#private` fields, so it can never exercise the hazard the Proxy's
    // `Reflect.get(target, prop, target)` receiver exists to avoid -- a getter reading a private
    // field throws when `this` is the Proxy. A fake cannot catch a contract mismatch with the
    // real class; only the real class can.
    //
    // No network: construction is offline (verified against @mastra/core 1.61.0), and nothing
    // here calls doGenerate.
    const real = new ModelRouterLanguageModel({
      id: "anthropic/claude-sonnet-4-6",
      apiKey: "sk-not-used",
    });
    const wrapped = wrapLedgeredMastraModel(db, real, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    // Touch every public member Mastra itself reads. If a future release turns any of them into a
    // private-field getter, this throws HERE rather than in production.
    expect(() => {
      void wrapped.specificationVersion;
      void wrapped.provider;
      void wrapped.modelId;
      void wrapped.supportedUrls;
      wrapped.serializeForSpan();
    }).not.toThrow();
    // Touching fields is not egress.
    expect(listEgress(db, {})).toHaveLength(0);
  });
});
