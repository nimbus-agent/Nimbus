import { describe, expect, test } from "bun:test";
import { type SavedToolEnvelope, ToolgenRegistry } from "./toolgen-registry.ts";
import type { ToolgenEnvelope } from "./toolgen-types.ts";

function env(toolId: string, sessionId = "s1"): ToolgenEnvelope {
  return {
    sessionId,
    scriptPath: `/tmp/${toolId}/index.ts`,
    approvedAt: 1,
    artifact: {
      toolId,
      toolName: toolId,
      description: "d",
      body: "b",
      approvedHosts: ["api.example.com"],
      credentialHosts: [],
      manifest: {
        id: `toolgen.${toolId}`,
        version: "0.0.0",
        permissions: { network: [], filesystem: { read: [], write: [] } },
        updateChannel: "stable",
      },
      inputSchema: { type: "object", properties: {} },
    },
  };
}

function savedEnvelope(
  toolId: string,
  overrides: Partial<Pick<SavedToolEnvelope, "needsCredentials">> = {},
): SavedToolEnvelope {
  return {
    toolId,
    needsCredentials: overrides.needsCredentials ?? false,
    artifact: {
      toolId,
      toolName: toolId,
      description: "d",
      body: "b",
      approvedHosts: ["api.example.com"],
      credentialHosts: overrides.needsCredentials === true ? ["api.example.com"] : [],
      manifest: {
        id: `toolgen.${toolId}`,
        version: "0.0.0",
        permissions: { network: [], filesystem: { read: [], write: [] } },
        updateChannel: "stable",
      },
      inputSchema: { type: "object", properties: {} },
    },
  };
}

describe("ToolgenRegistry", () => {
  test("tools are scoped to their session", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.register(env("tg_b", "s2"), async () => {});
    expect(r.forSession("s1").map((e) => e.artifact.toolId)).toEqual(["tg_a"]);
    expect(r.countForSession("s2")).toBe(1);
    expect(r.forSession("s3")).toEqual([]);
  });

  test("a terminated tool is excluded from the session listing", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a"), async () => {});
    r.markTerminated("tg_a");
    expect(r.isTerminated("tg_a")).toBe(true);
    expect(r.forSession("s1")).toEqual([]);
  });

  test("revoke calls the close hook and drops the tool", async () => {
    const r = new ToolgenRegistry();
    let closed = false;
    r.register(env("tg_a"), async () => {
      closed = true;
    });
    await r.revoke("tg_a");
    expect(closed).toBe(true);
    expect(r.get("tg_a")).toBeUndefined();
  });

  test("revokeAll drains every session — the shutdown path", async () => {
    const r = new ToolgenRegistry();
    let closes = 0;
    r.register(env("tg_a", "s1"), async () => {
      closes += 1;
    });
    r.register(env("tg_b", "s2"), async () => {
      closes += 1;
    });
    await r.revokeAll();
    expect(closes).toBe(2);
    expect(r.forSession("s1")).toEqual([]);
  });

  test("a close hook that throws does not block the other revocations", async () => {
    const r = new ToolgenRegistry();
    let closed = false;
    r.register(env("tg_a", "s1"), async () => {
      throw new Error("boom");
    });
    r.register(env("tg_b", "s2"), async () => {
      closed = true;
    });
    await r.revokeAll();
    expect(closed).toBe(true);
  });
});

describe("saved tools (spec § 7.2) — visible everywhere, budget-free", () => {
  test("a saved tool is visible from a session that did not create it", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("t1"));
    expect(r.forSession("some-other-session").map((e) => e.artifact.toolId)).toContain("t1");
  });

  test("saved tools do NOT consume the per-session creation budget", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("s1"));
    r.registerSaved(savedEnvelope("s2"));
    r.registerSaved(savedEnvelope("s3"));
    // Else saving 3 tools would permanently disable tool creation for every future session.
    expect(r.countForSession("cli")).toBe(0);
  });

  test("ephemeral tools remain session-scoped even once saved tools exist", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("saved_a"));
    r.register(env("e1", "session-a"), async () => {});
    expect(r.forSession("session-b").map((e) => e.artifact.toolId)).not.toContain("e1");
    // The saved tool is still there for session-b -- only the ephemeral one is scoped.
    expect(r.forSession("session-b").map((e) => e.artifact.toolId)).toContain("saved_a");
  });

  test("a saved tool needing credentials is still LISTED but flagged", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("needs_creds", { needsCredentials: true }));
    const entries = r.forSession("any-session");
    expect(entries.map((e) => e.artifact.toolId)).toContain("needs_creds");
    const entry = entries.find((e) => e.artifact.toolId === "needs_creds");
    // Only a SavedToolEnvelope carries `needsCredentials` -- an ephemeral ToolgenEnvelope does not.
    expect((entry as SavedToolEnvelope).needsCredentials).toBe(true);
  });

  test("savedTools() returns every registered saved tool, independent of any session", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("a"));
    r.registerSaved(savedEnvelope("b"));
    expect(
      r
        .savedTools()
        .map((e) => e.toolId)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  test("registerSaved is idempotent by toolId -- a resave replaces, not duplicates", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("t1", { needsCredentials: false }));
    r.registerSaved(savedEnvelope("t1", { needsCredentials: true }));
    expect(r.savedTools()).toHaveLength(1);
    expect(r.savedTools()[0]?.needsCredentials).toBe(true);
  });

  test("a live ephemeral tool and a saved tool sharing a toolId both surface -- neither shadows the other", () => {
    const r = new ToolgenRegistry();
    r.register(env("dup", "s1"), async () => {});
    r.registerSaved(savedEnvelope("dup"));
    expect(r.forSession("s1").filter((e) => e.artifact.toolId === "dup")).toHaveLength(2);
  });
});

describe("findArtifact -- the union lookup a per-request broker check needs", () => {
  test("resolves a SAVED tool's artifact, which get() cannot see", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnvelope("saved_only"));
    expect(r.get("saved_only")).toBeUndefined();
    expect(r.findArtifact("saved_only")?.toolId).toBe("saved_only");
  });

  test("resolves a live ephemeral tool's artifact", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a"), async () => {});
    expect(r.findArtifact("tg_a")?.toolId).toBe("tg_a");
  });

  test("an unknown toolId resolves to undefined, never a throw", () => {
    const r = new ToolgenRegistry();
    expect(r.findArtifact("never-registered")).toBeUndefined();
  });

  test("the ephemeral entry wins when a toolId exists in both collections", () => {
    const r = new ToolgenRegistry();
    r.register(env("dup", "s1"), async () => {});
    r.registerSaved({
      ...savedEnvelope("dup"),
      artifact: { ...savedEnvelope("dup").artifact, approvedHosts: ["saved-only.example.com"] },
    });
    // The live ephemeral artifact's own hosts, not the saved one's -- an in-session tool being
    // resaved under the same id must not have its live requests re-authorized against the OLDER
    // saved artifact while the new approval is still pending.
    expect(r.findArtifact("dup")?.approvedHosts).toEqual(["api.example.com"]);
  });
});

describe("an unknown toolId is a no-op, never a throw", () => {
  // Both arms matter for a real reason: `wireExitCallback` fires `markTerminated` AFTER an
  // owner-initiated `revoke()` has already deleted the entry (see `spawnGeneratedTool`'s doc
  // comment, which calls that sequence "harmless and expected"). If either of these threw or
  // reported a stale value, that ordinary revoke-then-exit race would surface as an error.
  test("markTerminated on a toolId that was never registered does nothing", () => {
    const registry = new ToolgenRegistry();
    expect(() => registry.markTerminated("tg_never")).not.toThrow();
    expect(registry.isTerminated("tg_never")).toBe(false);
  });

  test("markTerminated after revoke() dropped the entry stays a no-op", () => {
    const registry = new ToolgenRegistry();
    registry.register(env("tg_a"), async () => {});
    return registry.revoke("tg_a").then(() => {
      registry.markTerminated("tg_a");
      // Not "terminated" — it is GONE, which `isTerminated` reports as false for an absent id.
      expect(registry.isTerminated("tg_a")).toBe(false);
      expect(registry.get("tg_a")).toBeUndefined();
    });
  });

  test("isTerminated distinguishes registered-and-live from registered-and-terminated", () => {
    const registry = new ToolgenRegistry();
    registry.register(env("tg_a"), async () => {});
    expect(registry.isTerminated("tg_a")).toBe(false);
    registry.markTerminated("tg_a");
    expect(registry.isTerminated("tg_a")).toBe(true);
  });
});
