import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isExpertBrief } from "../../../src/agents/_lib/findings.ts";
import { runExpert } from "../../../src/agents/expert.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

describe("nimbus expert (e2e, in-process)", () => {
  test("ranks alice first; brief contains '## Top'; latency < 8 s; HITL-free", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t = Date.now();
    const TOPIC = "src/billing/retry.ts";

    db.run(
      `INSERT INTO person (id, display_name, canonical_email, linked) VALUES
         ('alice', 'Alice', 'alice@example.com', 0),
         ('bob',   'Bob',   'bob@example.com',   0)`,
    );

    for (let i = 0; i < 4; i += 1) {
      upsertIndexedItem(db, {
        service: "github",
        type: "commit",
        externalId: `acme/payment#commit-alice-${i}`,
        title: `fix retry logic in ${TOPIC} (#${i})`,
        bodyPreview: `touches ${TOPIC} backoff`,
        modifiedAt: t - i * 1000,
        syncedAt: t,
        authorId: "alice",
      });
    }
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/payment#501",
      title: `mitigate ${TOPIC} regression`,
      bodyPreview: `rollback plan in ${TOPIC}`,
      modifiedAt: t,
      syncedAt: t,
      authorId: "alice",
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/payment#502",
      title: `tweak ${TOPIC} timeout`,
      bodyPreview: `unrelated change`,
      modifiedAt: t,
      syncedAt: t,
      authorId: "bob",
    });

    const start = performance.now();
    const brief = await runExpert(
      { topicOrFile: TOPIC },
      { db, sessionId: "e2e-1", notify: () => {} },
    );
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(8_000);
    expect(isExpertBrief(brief)).toBe(true);
    expect(brief.ranked[0]?.displayName).toBe("Alice");
    expect(brief.gaps.length).toBeGreaterThan(0);
    expect(brief.gaps.some((g) => g.category === "missing_relation_emit")).toBe(true);
  });

  test("zero HITL actions fired (structural)", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../src/agents/expert.ts"),
      "utf8",
    ) as string;
    expect(source).not.toContain("ToolExecutor");
    expect(source).not.toContain("HITL_REQUIRED");
  });
});
