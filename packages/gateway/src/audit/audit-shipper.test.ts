import { describe, expect, test } from "bun:test";
import { type AuditMetaRow, shipBatch, toShippableLine } from "./audit-shipper.ts";

const rows: AuditMetaRow[] = [
  {
    id: 1,
    actionType: "policy.applied",
    hitlStatus: "not_required",
    hash: "abc",
    timestamp: 100,
    actionJson: '{"secret":"x"}',
  },
];

describe("audit-shipper", () => {
  test("toShippableLine emits metadata ONLY — never actionJson", () => {
    const line = JSON.parse(toShippableLine(rows[0] as AuditMetaRow));
    expect(line).toEqual({
      id: 1,
      actionType: "policy.applied",
      hitlStatus: "not_required",
      hash: "abc",
      timestamp: 100,
    });
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  test("shipBatch POSTs NDJSON and returns the count shipped", async () => {
    let body = "";
    const n = await shipBatch(rows, {
      shipTo: "https://siem/x",
      post: async (_u, b) => {
        body = b;
        return true;
      },
    });
    expect(n).toBe(1);
    expect(body.trim().split("\n")).toHaveLength(1);
    expect(body).not.toContain("secret");
  });

  test("shipBatch returns 0 and does not throw when the POST fails", async () => {
    const n = await shipBatch(rows, { shipTo: "https://siem/x", post: async () => false });
    expect(n).toBe(0);
  });

  test("empty batch ships nothing", async () => {
    expect(await shipBatch([], { shipTo: "https://siem/x", post: async () => true })).toBe(0);
  });
});
