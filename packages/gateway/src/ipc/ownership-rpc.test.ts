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

/**
 * Notification-driven wait: resolves as soon as `expectedMethod` is notified, instead of
 * a fixed sleep — a fixed sleep is flaky on a slow runner (too short) or slow everywhere
 * (too long). A generous timeout guards against a genuine hang.
 */
function waitForNotification(expectedMethod: string): {
  seen: Array<{ method: string; params: unknown }>;
  notify: (method: string, params: unknown) => void;
  ready: Promise<void>;
} {
  const seen: Array<{ method: string; params: unknown }> = [];
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const notify = (method: string, params: unknown): void => {
    seen.push({ method, params });
    if (method === expectedMethod) resolveReady();
  };
  const ready = Promise.race([
    readyPromise,
    Bun.sleep(2000).then(() => {
      throw new Error(`timed out waiting for notification "${expectedMethod}"`);
    }),
  ]);
  return { seen, notify, ready };
}

describe("dispatchOwnershipRpc", () => {
  test("ownership.refresh returns a jobId and emits passDone", async () => {
    const { seen, notify, ready } = waitForNotification("ownership.passDone");
    const out = await dispatchOwnershipRpc(
      "ownership.refresh",
      {},
      {
        refresher: fakeRefresher(async () => SUMMARY),
        notify,
      },
    );

    expect(out.kind).toBe("hit");
    await ready;
    expect(seen.some((s) => s.method === "ownership.passDone")).toBe(true);
  });

  test("a refusal from the refresher surfaces as passError", async () => {
    const { seen, notify, ready } = waitForNotification("ownership.passError");
    await dispatchOwnershipRpc(
      "ownership.refresh",
      {},
      {
        refresher: fakeRefresher(async () => {
          throw new OwnershipRefresherError("ERR_OWNERSHIP_PASS_RUNNING: already running");
        }),
        notify,
      },
    );

    await ready;
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
