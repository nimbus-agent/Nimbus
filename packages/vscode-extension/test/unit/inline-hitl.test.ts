import { describe, expect, test, vi } from "vitest";
import type { ChatPanel } from "../../src/chat/chat-panel.js";
import { createInlineHitlSurface } from "../../src/extension.js";
import type { HitlDecision } from "../../src/hitl/hitl-router.js";

function makePanel(): {
  panel: ChatPanel;
  posted: unknown[];
} {
  const posted: unknown[] = [];
  const panel: ChatPanel = {
    reveal: () => undefined,
    dispose: () => undefined,
    panel: () => undefined,
    onDispose: () => undefined,
    onMessage: () => undefined,
    postMessage: (m) => {
      posted.push(m);
      return Promise.resolve(true);
    },
    isVisible: () => true,
    isActive: () => true,
  };
  return { panel, posted };
}

describe("createInlineHitlSurface", () => {
  test("posts hitlInline and resolves on webview hitlResponse", async () => {
    const { panel, posted } = makePanel();
    const pending = new Map<string, (d: HitlDecision | undefined) => void>();
    const fallback = vi.fn(async () => undefined);
    const surface = createInlineHitlSurface({
      getPanel: () => panel,
      pending,
      fallback,
    });

    const promise = surface({ requestId: "r1", prompt: "Approve?" });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "hitlInline",
      requestId: "r1",
      prompt: "Approve?",
    });
    expect((posted[0] as { details?: unknown }).details).toBeUndefined();

    const resolver = pending.get("r1");
    expect(resolver).toBeDefined();
    resolver?.("approve");

    expect(await promise).toBe("approve");
    expect(fallback).not.toHaveBeenCalled();
  });

  test("forwards details when present", async () => {
    const { panel, posted } = makePanel();
    const pending = new Map<string, (d: HitlDecision | undefined) => void>();
    const surface = createInlineHitlSurface({
      getPanel: () => panel,
      pending,
      fallback: vi.fn(async () => undefined),
    });
    void surface({
      requestId: "r2",
      prompt: "p",
      details: { actions: ["delete /etc/passwd"] },
    });
    expect((posted[0] as { details?: unknown }).details).toEqual({
      actions: ["delete /etc/passwd"],
    });
  });

  test("delegates to fallback when no panel is mounted", async () => {
    const fallback = vi.fn(async () => "reject" as HitlDecision);
    const surface = createInlineHitlSurface({
      getPanel: () => undefined,
      pending: new Map(),
      fallback,
    });
    const r = await surface({ requestId: "r3", prompt: "Q" });
    expect(r).toBe("reject");
    expect(fallback).toHaveBeenCalledWith({ requestId: "r3", prompt: "Q" });
  });

  test("two concurrent requests are tracked independently", async () => {
    const { panel } = makePanel();
    const pending = new Map<string, (d: HitlDecision | undefined) => void>();
    const surface = createInlineHitlSurface({
      getPanel: () => panel,
      pending,
      fallback: vi.fn(async () => undefined),
    });
    const a = surface({ requestId: "a", prompt: "A" });
    const b = surface({ requestId: "b", prompt: "B" });
    pending.get("b")?.("approve");
    pending.get("a")?.("reject");
    expect(await Promise.all([a, b])).toEqual(["reject", "approve"]);
  });
});
