import { describe, expect, test } from "bun:test";

import { OwnershipRefresherError } from "../ownership/ownership-refresh.ts";
import { dispatchOwnershipRpc } from "./ownership-rpc.ts";

const SUMMARY = {
  rootsTotal: 1,
  rootsCovered: 1,
  rootsWithRemote: 0,
  filesCovered: 2,
  filesExcluded: 0,
  servicesBound: 0,
  ownersEmitted: 3,
  entitiesReaped: 0,
  durationMs: 5,
};

function fakeRefresher(run: () => Promise<typeof SUMMARY>) {
  return { trigger: () => {}, run, stop: () => {} };
}

describe("dispatchOwnershipRpc", () => {
  test("ownership.refresh returns a jobId and emits passDone", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const out = await dispatchOwnershipRpc(
      "ownership.refresh",
      {},
      {
        refresher: fakeRefresher(async () => SUMMARY),
        notify: (method, params) => seen.push({ method, params }),
      },
    );

    expect(out.kind).toBe("hit");
    await Bun.sleep(10);
    expect(seen.some((s) => s.method === "ownership.passDone")).toBe(true);
  });

  test("a refusal from the refresher surfaces as passError", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    await dispatchOwnershipRpc(
      "ownership.refresh",
      {},
      {
        refresher: fakeRefresher(async () => {
          throw new OwnershipRefresherError("ERR_OWNERSHIP_PASS_RUNNING: already running");
        }),
        notify: (method, params) => seen.push({ method, params }),
      },
    );

    await Bun.sleep(10);
    const err = seen.find((s) => s.method === "ownership.passError");
    expect((err?.params as { code: number } | undefined)?.code).toBe(-32000);
    expect((err?.params as { message: string } | undefined)?.message).toContain(
      "ERR_OWNERSHIP_PASS_RUNNING",
    );
  });

  test("an unknown ownership.* method misses", async () => {
    const out = await dispatchOwnershipRpc(
      "ownership.nope",
      {},
      {
        refresher: fakeRefresher(async () => SUMMARY),
        notify: () => {},
      },
    );
    expect(out.kind).toBe("miss");
  });
});
