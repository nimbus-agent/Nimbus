import { describe, expect, it } from "bun:test";
import { quorumCoordinator } from "./quorum-singleton.ts";

describe("quorumCoordinator singleton", () => {
  it("broadcasts the requestId via the late-bound channel", async () => {
    const seen: string[] = [];
    quorumCoordinator.setBroadcast((requestId) => seen.push(requestId));
    const p = quorumCoordinator.collect({ approvers: 1, windowMs: 5000 });
    expect(seen).toHaveLength(1);
    quorumCoordinator.respond(seen[0]!, "peer:a", true);
    expect((await p).outcome).toBe("approved");
  });
});
