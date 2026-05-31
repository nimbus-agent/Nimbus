import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { buildContextWindow } from "../../../src/engine/context-ranker.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

function openIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

function indexedItemTypeForService(
  svc: "google_drive" | "github" | "slack" | "linear",
): "file" | "pr" | "message" | "issue" {
  if (svc === "github") {
    return "pr";
  }
  if (svc === "slack") {
    return "message";
  }
  if (svc === "linear") {
    return "issue";
  }
  return "file";
}

describe("cross-service query (local index)", () => {
  test("FTS + ranking returns items from multiple services; median latency under CI budget", () => {
    const idx = openIndex();
    const db = idx.getDatabase();
    const t = Date.now();
    const services = ["google_drive", "github", "slack", "linear"] as const;
    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      upsertIndexedItem(db, {
        service: svc,
        type: indexedItemTypeForService(svc),
        externalId: `x${String(i)}`,
        title: `Sprint payment-service touchpoint ${String(i)}`,
        bodyPreview: `work touched this sprint across ${svc}`,
        modifiedAt: t - i * 60_000,
        syncedAt: t,
      });
    }

    const timingsMs: number[] = [];
    for (let run = 0; run < 12; run++) {
      const t0 = performance.now();
      const ranked = idx.searchRanked({ name: "sprint payment touched", limit: 50 }, {});
      const window = buildContextWindow(ranked, 20);
      timingsMs.push(performance.now() - t0);
      if (run === 0) {
        expect(ranked.length).toBeGreaterThanOrEqual(4);
        const svcSet = new Set(ranked.map((r) => r.service));
        expect(svcSet.has("google_drive")).toBe(true);
        expect(svcSet.has("github")).toBe(true);
        expect(svcSet.has("slack")).toBe(true);
        expect(svcSet.has("linear")).toBe(true);
        expect(window.totalMatches).toBeGreaterThanOrEqual(4);
      }
    }
    timingsMs.sort((a, b) => a - b);
    const median = timingsMs[Math.floor(timingsMs.length / 2)] ?? 0;
    expect(median).toBeLessThan(800);

    idx.close();
  });
});
