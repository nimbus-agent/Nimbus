import { describe, expect, test } from "bun:test";
import { mergeTeamAudit } from "./audit-merge.ts";

describe("mergeTeamAudit", () => {
  test("merges per-peer streams into one timeline sorted by timestamp, tagged by peer", () => {
    const merged = mergeTeamAudit([
      {
        peerId: "peer:aa",
        entries: [{ actionType: "federation.query", hitlStatus: "x", hash: "h1", timestamp: 200 }],
      },
      {
        peerId: "peer:bb",
        entries: [{ actionType: "federation.query", hitlStatus: "x", hash: "h2", timestamp: 100 }],
      },
    ]);
    expect(merged.map((m) => m.peerId)).toEqual(["peer:bb", "peer:aa"]);
    expect(merged[0]?.timestamp).toBe(100);
  });
  test("empty streams => empty timeline", () => {
    expect(mergeTeamAudit([])).toEqual([]);
    expect(mergeTeamAudit([{ peerId: "p", entries: [] }])).toEqual([]);
  });
});
