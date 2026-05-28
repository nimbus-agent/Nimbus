import type { HitlRequest } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";
import {
  createHitlRouter,
  type HitlDecision,
  type HitlRouterDeps,
} from "../../src/hitl/hitl-router.js";

function makeDeps(opts: { chatVisibleAndFocused: boolean; alwaysModal?: boolean }): HitlRouterDeps {
  return {
    chatPanelVisibleAndFocused: () => opts.chatVisibleAndFocused,
    streamRegistered: (sid) => sid === "active-stream",
    showInline: vi.fn(async () => "approve" as const),
    showToast: vi.fn(async () => "approve" as const),
    showModal: vi.fn(async () => "approve" as const),
    sendResponse: vi.fn(async () => undefined),
    onCountChange: vi.fn(),
    alwaysModal: () => opts.alwaysModal ?? false,
  };
}

const REQ: HitlRequest = { requestId: "req-1", prompt: "Approve action?" };

describe("HitlRouter", () => {
  test("routes inline when stream-tagged AND chat is visible+focused", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: true });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ, streamId: "active-stream" });
    expect(deps.showInline).toHaveBeenCalled();
    expect(deps.showToast).not.toHaveBeenCalled();
    expect(deps.showModal).not.toHaveBeenCalled();
  });

  test("routes toast for background HITL by default", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ });
    expect(deps.showToast).toHaveBeenCalled();
    expect(deps.showModal).not.toHaveBeenCalled();
  });

  test("routes modal when nimbus.hitlAlwaysModal is true", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false, alwaysModal: true });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ });
    expect(deps.showModal).toHaveBeenCalled();
    expect(deps.showToast).not.toHaveBeenCalled();
  });

  test("dedupes duplicate requestIds", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false });
    const router = createHitlRouter(deps);
    await Promise.all([router.handle({ ...REQ }), router.handle({ ...REQ })]);
    expect(deps.showToast).toHaveBeenCalledTimes(1);
  });

  test("emits count changes (+1 on enqueue, -1 on response)", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ });
    expect(deps.onCountChange).toHaveBeenCalled();
    const counts = (
      deps.onCountChange as unknown as { mock: { calls: [number][] } }
    ).mock.calls.map(([n]) => n);
    expect(counts).toEqual(expect.arrayContaining([1, 0]));
  });

  test("snapshot returns currently-pending requests", async () => {
    const deps: HitlRouterDeps = {
      ...makeDeps({ chatVisibleAndFocused: false }),
      showToast: vi.fn((): Promise<HitlDecision | undefined> => new Promise(() => undefined)),
    };
    const router = createHitlRouter(deps);
    void router.handle({ requestId: "r-pending", prompt: "p" });
    await new Promise((r) => setTimeout(r, 5));
    expect(router.snapshot().map((r) => r.requestId)).toContain("r-pending");
  });
});
