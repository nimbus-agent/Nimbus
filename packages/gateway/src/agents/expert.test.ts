import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { rankExpertFindings, runExpert } from "./expert.ts";

describe("rankExpertFindings", () => {
  test("merges evidence from multiple streams by personId, summing weights", () => {
    const evidence = [
      {
        personId: "alice",
        displayName: "Alice",
        evidence: [
          {
            weight: 1.0,
            modifiedAt: 0,
            type: "pr_authored" as const,
            serviceId: "github",
            title: "t1",
            itemId: "i1",
          },
        ],
      },
      {
        personId: "alice",
        displayName: "Alice",
        evidence: [
          {
            weight: 0.6,
            modifiedAt: 0,
            type: "pr_reviewed" as const,
            serviceId: "github",
            title: "t2",
            itemId: "i2",
          },
        ],
      },
      {
        personId: "bob",
        displayName: "Bob",
        evidence: [
          {
            weight: 0.3,
            modifiedAt: 0,
            type: "chat_post" as const,
            serviceId: "slack",
            title: "t3",
            itemId: "i3",
          },
        ],
      },
    ];
    const ranked = rankExpertFindings(evidence, 5);
    expect(ranked[0]?.personId).toBe("alice");
    expect(ranked[0]?.evidence).toHaveLength(2);
    expect(ranked[1]?.personId).toBe("bob");
  });

  test("respects the limit", () => {
    const evidence = Array.from({ length: 12 }, (_, i) => ({
      personId: `p${i}`,
      displayName: `P${i}`,
      evidence: [
        {
          weight: 12 - i,
          modifiedAt: 0,
          type: "pr_authored" as const,
          serviceId: "github",
          title: "t",
          itemId: `i${i}`,
        },
      ],
    }));
    const ranked = rankExpertFindings(evidence, 5);
    expect(ranked).toHaveLength(5);
    expect(ranked[0]?.personId).toBe("p0");
  });

  test("confidence buckets reflect score and evidence count", () => {
    const high = rankExpertFindings(
      [
        {
          personId: "a",
          displayName: "A",
          evidence: Array.from({ length: 6 }, () => ({
            weight: 0.9,
            modifiedAt: 0,
            type: "pr_authored" as const,
            serviceId: "github",
            title: "t",
            itemId: "i",
          })),
        },
      ],
      5,
    );
    expect(high[0]?.confidence).toBe("high");

    const ranked = rankExpertFindings(
      [
        {
          personId: "a",
          displayName: "A",
          evidence: Array.from({ length: 5 }, () => ({
            weight: 1.0,
            modifiedAt: 0,
            type: "pr_authored" as const,
            serviceId: "github",
            title: "t",
            itemId: "i",
          })),
        },
        {
          personId: "b",
          displayName: "B",
          evidence: [
            {
              weight: 0.05,
              modifiedAt: 0,
              type: "pr_authored",
              serviceId: "github",
              title: "t",
              itemId: "i",
            },
          ],
        },
      ],
      5,
    );
    expect(ranked[0]?.personId).toBe("a");
    expect(ranked[1]?.confidence).toBe("low");
  });
});

describe("runExpert gap-note coverage", () => {
  test("empty index produces an empty_index gap note", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const ctx = {
      db,
      notify: () => {},
      sessionId: "s1",
    };
    const brief = await runExpert({ topicOrFile: "anything" }, ctx);
    const cats = brief.gaps.map((g) => g.category);
    expect(cats).toContain("empty_index");
    expect(brief.ranked).toEqual([]);
  });

  test("missing reviewed relation surfaces a missing_relation_emit gap note", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('github:dummy', 'github', 'pr', 'dummy', 'noop', 0, 0)`,
    );

    const ctx = { db, notify: () => {}, sessionId: "s1" };
    const brief = await runExpert({ topicOrFile: "noop" }, ctx);
    const cats = brief.gaps.map((g) => g.category);
    expect(cats).toContain("missing_relation_emit");
  });
});
