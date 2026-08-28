import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listEgress } from "../egress/egress-verify.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LlmRegistry } from "../llm/registry.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "../llm/types.ts";
import { classifyIntent } from "./router.ts";

/**
 * The WIRE, not the ends.
 *
 * `router.test.ts` injects `generate` and proves the classifier asks for the right thing;
 * `egress/model-egress.test.ts` proves a wrapped provider appends. Neither proves the two are
 * connected — and "both ends tested, wire dead" is exactly the shape that let the classifier
 * egress unledgered for as long as it did. This file runs the real `LlmRouter` over a real
 * ledger-wrapped provider against a real SQLite ledger.
 */
function provider(providerId: string, isLocal: boolean, text: string): LlmProvider {
  return {
    providerId,
    isLocal,
    isAvailable: async () => true,
    listModels: async () => [{ provider: providerId, modelName: "claude-x" }],
    generate: async (_opts: LlmGenerateOptions): Promise<LlmGenerateResult> => ({
      text,
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "m",
      isLocal,
      provider: providerId,
    }),
  };
}

const CLASSIFIED = JSON.stringify({
  intent: "file_search",
  entities: { pattern: "*.md" },
  confidence: 0.9,
});

describe("classifyIntent appends an I29 model row for a REMOTE route", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  // The PRODUCTION registration path. `LlmRegistry.addRoute` is where `wrapLedgeredProvider`
  // is applied (D22(e) confines `registerRoute` to it precisely so no other path can skip the
  // wrap), so building the route any other way here would test a wire that does not ship.
  function registryWith(isLocal: boolean): LlmRegistry {
    const registry = new LlmRegistry({
      config: {
        preferLocal: false,
        enforceAirGap: false,
        minReasoningParams: 0,
        remoteModel: "claude-x",
        localModel: "",
      },
      db,
    });
    registry.addRoute(provider("anthropic", isLocal, CLASSIFIED), "claude-x");
    return registry;
  }

  test("a remote classification appends exactly one row, named engine.ask.classify", async () => {
    const registry = registryWith(false);
    const result = await classifyIntent("find my notes", {
      enforceAirGap: false,
      generate: (opts) => registry.llmRouter.generate(opts),
    });

    expect(result.intent).toBe("file_search");
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceType).toBe("model");
    expect(rows[0]?.method).toBe("engine.ask.classify");
    expect(rows[0]?.destination).toBe("anthropic");
  });

  test("a LOCAL classification appends nothing — no request left the machine", async () => {
    const registry = registryWith(true);
    const result = await classifyIntent("find my notes", {
      enforceAirGap: false,
      generate: (opts) => registry.llmRouter.generate(opts),
    });

    expect(result.intent).toBe("file_search");
    expect(listEgress(db, {})).toHaveLength(0);
  });
});
