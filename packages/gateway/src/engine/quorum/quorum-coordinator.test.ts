import { describe, expect, it } from "bun:test";
import { QuorumCoordinator } from "./quorum-coordinator.ts";

function makeCoord() {
  const broadcasts: Array<{ requestId: string }> = [];
  const coord = new QuorumCoordinator((requestId) => broadcasts.push({ requestId }));
  return { coord, broadcasts };
}

describe("QuorumCoordinator (I21)", () => {
  it("resolves 'approved' only after N distinct peers approve", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 10_000 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    coord.respond(requestId, "peer:b", true);
    expect(await p).toEqual({ outcome: "approved", approvers: ["peer:a", "peer:b"] });
  });

  it("does NOT count the same peer twice (no double-count)", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 50 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    coord.respond(requestId, "peer:a", true); // duplicate — ignored
    const r = await p; // window elapses with only 1 distinct approver
    expect(r.outcome).toBe("failed");
  });

  it("a single explicit denial aborts immediately (fail-closed, D9)", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 10_000 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    coord.respond(requestId, "peer:b", false); // denial
    expect((await p).outcome).toBe("denied");
  });

  it("times out to 'failed' with the partial approver set", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 30 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    const r = await p;
    expect(r.outcome).toBe("failed");
    expect(r.approvers).toEqual(["peer:a"]);
  });

  it("ignores responses for an unknown/expired requestId", async () => {
    const { coord } = makeCoord();
    expect(coord.respond("nope", "peer:a", true)).toBe(false);
  });
});
