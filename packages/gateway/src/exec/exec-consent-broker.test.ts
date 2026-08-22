import { afterEach, describe, expect, test } from "bun:test";
import { type ExecApprovalInput, ExecConsentBroker } from "./exec-consent-broker.ts";

const brokers: ExecConsentBroker[] = [];
function makeBroker(): ExecConsentBroker {
  const b = new ExecConsentBroker();
  brokers.push(b);
  return b;
}

// Every pending request holds a live (deliberately non-unref'd) TTL timer. Without this hook a
// test that leaves one pending hangs `bun test` teardown on Windows.
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
});

const INPUT: ExecApprovalInput = {
  executionId: "e1",
  runtime: "bun",
  codeBody: "console.log(1)",
  grants: { fsRead: [], fsWrite: [], network: [] },
  wallClockMs: 1000,
  cwd: "/tmp",
};

describe("ExecConsentBroker", () => {
  test("broadcasts exec.approvalRequest with a requestId", async () => {
    const b = makeBroker();
    const seen: Array<{ method: string; params: unknown }> = [];
    b.setBroadcast((method, params) => {
      seen.push({ method, params });
    });
    const p = b.request(INPUT, 5000);
    const first = seen[0];
    if (first === undefined) throw new Error("expected a broadcast");
    expect(first.method).toBe("exec.approvalRequest");
    const id = (first.params as { requestId: string }).requestId;
    b.respond(id, true);
    expect(await p).toBe(true);
  });

  test("the broadcast carries the VERBATIM code body, not a digest", async () => {
    const b = makeBroker();
    let params: Record<string, unknown> = {};
    b.setBroadcast((_m, p) => {
      params = p as Record<string, unknown>;
    });
    const promise = b.request(INPUT, 5000);
    expect(params["codeBody"]).toBe("console.log(1)");
    b.respond(params["requestId"] as string, false);
    await promise;
  });

  test("TWO concurrent requests resolve independently", async () => {
    const b = makeBroker();
    const ids: string[] = [];
    b.setBroadcast((_m, params) => {
      ids.push((params as { requestId: string }).requestId);
    });
    const first = b.request(INPUT, 5000);
    const second = b.request(INPUT, 5000);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);

    b.respond(ids[1] as string, true);
    expect(await second).toBe(true);
    // Answering one must NOT settle the other.
    expect(b.pendingIds()).toEqual([ids[0] as string]);

    b.respond(ids[0] as string, false);
    expect(await first).toBe(false);
  });

  test("fails closed when the owner never answers", async () => {
    const b = makeBroker();
    b.setBroadcast(() => {});
    expect(await b.request(INPUT, 1)).toBe(false);
  });

  test("responding to an unknown requestId reports no match", () => {
    const b = makeBroker();
    b.setBroadcast(() => {});
    expect(b.respond("nope", true)).toBe(false);
  });
});
