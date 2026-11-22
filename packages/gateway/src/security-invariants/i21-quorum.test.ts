import { describe, expect, test } from "bun:test";

describe("I21 — quorum counts only DISTINCT authenticated peers", () => {
  test("the same peer approving twice does not satisfy a 2-of-N quorum", async () => {
    const { QuorumCoordinator } = await import("../engine/quorum/quorum-coordinator.ts");
    const ids: string[] = [];
    const coord = new QuorumCoordinator((requestId: string) => ids.push(requestId));
    const p = coord.collect({ approvers: 2, windowMs: 30 });
    coord.respond(ids[0] ?? "", "peer:a", true);
    coord.respond(ids[0] ?? "", "peer:a", true); // duplicate — must NOT count
    const r = await p;
    expect(r.outcome).toBe("failed"); // window elapses with only 1 distinct approver
  });
});
