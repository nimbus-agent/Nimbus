import { describe, expect, test } from "bun:test";
import { buildGeneratedTools } from "./toolgen-agent-tools.ts";
import { type SavedToolEnvelope, ToolgenRegistry } from "./toolgen-registry.ts";

const wrap = <T>(_service: string, _tool: string, def: T): T => def;

import type { ToolgenEnvelope } from "./toolgen-types.ts";

/**
 * `ToolgenRegistry.forSession` filters by exact session-id match, so a registry holding only "s1"
 * would ALSO return `[]` for `forSession(undefined)` even if `buildGeneratedTools`'s own
 * `sessionId === undefined` guard were deleted -- asserting on the output alone can't tell "refused
 * before ever asking the registry" from "asked, and happened to get nothing back". This subclass
 * counts calls so the undefined-session test below can pin down the guard itself, not the
 * registry's incidentally-correct filtering.
 */
class CountingRegistry extends ToolgenRegistry {
  forSessionCalls = 0;
  override forSession(sessionId: string): Array<ToolgenEnvelope | SavedToolEnvelope> {
    this.forSessionCalls += 1;
    return super.forSession(sessionId);
  }
}

function env(toolId: string, sessionId: string): ToolgenEnvelope {
  return {
    sessionId,
    scriptPath: "/tmp",
    approvedAt: 1,
    artifact: {
      toolId,
      toolName: toolId,
      description: "d",
      body: "b",
      approvedHosts: [],
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

describe("buildGeneratedTools", () => {
  test("contributes NOTHING when the session holds no generated tool", () => {
    expect(buildGeneratedTools("s1", new ToolgenRegistry(), async () => null, wrap)).toEqual({});
  });

  test("contributes NOTHING for an undefined session, without ever consulting the registry", () => {
    const r = new CountingRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    expect(buildGeneratedTools(undefined, r, async () => null, wrap)).toEqual({});
    expect(r.forSessionCalls).toBe(0);
  });

  test("exposes only the CURRENT session's tools", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.register(env("tg_b", "s2"), async () => {});
    expect(Object.keys(buildGeneratedTools("s1", r, async () => null, wrap))).toEqual(["tg_a"]);
  });

  test("a terminated tool disappears from the surface", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.markTerminated("tg_a");
    expect(buildGeneratedTools("s1", r, async () => null, wrap)).toEqual({});
  });

  test("I11 — every generated tool passes through the envelope wrapper", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    const wrapped: string[] = [];
    const spy = <T>(service: string, tool: string, def: T): T => {
      wrapped.push(`${service}:${tool}`);
      return def;
    };
    buildGeneratedTools("s1", r, async () => null, spy);
    // A generated tool returns a remote API response straight into the model's context. If this
    // ever passes vacuously, an external server can address the agent directly.
    expect(wrapped).toEqual(["toolgen:tg_a"]);
  });

  test("a generated tool advertises its approved parameters, not a passthrough schema", () => {
    const schema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    };
    const registry = {
      forSession: () => [{ artifact: { toolId: "t1", description: "d", inputSchema: schema } }],
    };
    const tools = buildGeneratedTools(
      "s1",
      registry as never,
      async () => ({}),
      (_s, _t, def) => def,
    );
    const tool = (
      tools as Record<string, { inputSchema: { safeParse(v: unknown): { success: boolean } } }>
    )["t1"];
    if (tool === undefined) throw new Error("expected tool t1 to be registered");
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ owner: "nimbus" }).success).toBe(true);
  });

  function savedEnv(toolId: string): SavedToolEnvelope {
    return {
      toolId,
      needsCredentials: false,
      artifact: {
        toolId,
        toolName: toolId,
        description: "d",
        body: "b",
        approvedHosts: [],
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

  // The interface note this task's plan carries: "buildGeneratedTools needs no change if
  // forSession unions -- but assert that, since it is the surface the model sees." This is that
  // assertion: no code in this file changed for a saved tool to reach the model, because
  // `buildGeneratedTools` only ever destructures `.artifact` off whatever `forSession` returns.
  test("a SAVED tool is offered to a session that never created it, exactly like an ephemeral one", () => {
    const r = new ToolgenRegistry();
    r.registerSaved(savedEnv("saved_a"));
    expect(
      Object.keys(buildGeneratedTools("some-other-session", r, async () => null, wrap)),
    ).toEqual(["saved_a"]);
  });

  test("ephemeral and saved tools coexist on the model surface without one shadowing the other", () => {
    const r = new ToolgenRegistry();
    r.register(env("tg_a", "s1"), async () => {});
    r.registerSaved(savedEnv("saved_b"));
    expect(Object.keys(buildGeneratedTools("s1", r, async () => null, wrap)).sort()).toEqual([
      "saved_b",
      "tg_a",
    ]);
  });
});
