import { expect, test } from "bun:test";

import { MockClient, type RankedSearchItem } from "./index.js";

const rankedItem: RankedSearchItem = {
  id: "doc-1",
  service: "drive",
  itemType: "file",
  name: "Quarterly plan",
  score: 0.92,
  indexPrimaryKey: "42",
  indexedType: "file",
  semanticSnippet: "…the quarterly plan covers…",
};

test("MockClient.searchRanked returns [] when no fixtures are configured", async () => {
  const client = new MockClient();
  expect(await client.searchRanked({ name: "plan" })).toEqual([]);
});

test("MockClient.searchRanked returns the configured ranked fixtures", async () => {
  const client = new MockClient({ rankedItems: [rankedItem] });
  const results = await client.searchRanked({ name: "plan", semantic: true, limit: 5 });
  expect(results).toHaveLength(1);
  expect(results[0]?.name).toBe("Quarterly plan");
  expect(results[0]?.score).toBeGreaterThan(0);
});

test("MockClient.searchRanked tolerates being called with no params", async () => {
  const client = new MockClient();
  expect(await client.searchRanked()).toEqual([]);
});
