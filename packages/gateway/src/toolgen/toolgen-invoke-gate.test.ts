import { describe, expect, test } from "bun:test";
import {
  __chainsSizeForTest,
  invokeSavedTool,
  type ToolgenInvokeDeps,
} from "./toolgen-invoke-gate.ts";

const ARTIFACT = {
  toolId: "t1",
  inputSchema: {
    type: "object" as const,
    properties: { q: { type: "string" as const } },
    required: ["q"],
  },
  approvedHosts: ["api.example.com"],
};

function deps(over: Partial<ToolgenInvokeDeps> = {}): ToolgenInvokeDeps {
  return {
    config: { enabled: true },
    enforced: { capabilitiesDisabled: new Set<string>() },
    registry: {
      savedTools: () => [{ toolId: "t1", artifact: ARTIFACT }],
    } as unknown as ToolgenInvokeDeps["registry"],
    spawn: async () => {
      throw new Error("spawn must not be reached in this test");
    },
    audit: () => {},
    now: () => 1_000,
    ...over,
  } as ToolgenInvokeDeps;
}

describe("invokeSavedTool refusals happen before any spawn", () => {
  test("capability disabled by config", async () => {
    const out = await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      deps({ config: { enabled: false } }),
    );
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INVOKE_DISABLED");
  });

  test("capability disabled by org policy", async () => {
    const out = await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      deps({ enforced: { capabilitiesDisabled: new Set(["tool_generation"]) } }),
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INVOKE_POLICY_DISABLED");
  });

  test("FAIL-CLOSED when the policy accessor is absent", async () => {
    // `isToolgenCapabilityEnabled` returns false on `enforced === undefined`: "cannot tell"
    // must never resolve to "allowed" for a standing, unattended execution capability.
    const d = deps();
    const out = await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      { ...d, enforced: undefined },
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INVOKE_POLICY_DISABLED");
  });

  test("unknown tool id", async () => {
    const out = await invokeSavedTool(
      { toolId: "nope" },
      deps({
        registry: { savedTools: () => [] } as unknown as ToolgenInvokeDeps["registry"],
      }),
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_NOT_SAVED");
  });

  test("an EPHEMERAL (created-but-unsaved) tool is refused, not run", async () => {
    // The trap this guards: `registry.findArtifact(id)` reads the ephemeral collection FIRST, so
    // using it here would let a `nimbus tool create` tool through the saved-only gate and fail
    // obscurely inside spawnSavedTool instead. The saved list is empty; an ephemeral entry exists.
    const out = await invokeSavedTool(
      { toolId: "ephemeral-1" },
      deps({
        registry: {
          savedTools: () => [],
          findArtifact: () => ARTIFACT, // present ephemerally — must NOT satisfy the check
        } as unknown as ToolgenInvokeDeps["registry"],
        spawn: async () => {
          throw new Error("must not spawn an unsaved tool");
        },
      }),
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_NOT_SAVED");
  });

  test("input that is not an object is refused", async () => {
    const out = await invokeSavedTool(
      { toolId: "t1", input: [] as unknown as Record<string, unknown> },
      deps(),
    );
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INPUT_INVALID");
  });

  test("a missing REQUIRED key is refused without spawning", async () => {
    // `deps().spawn` throws if reached — so this assertion also proves no process was created.
    const out = await invokeSavedTool({ toolId: "t1", input: {} }, deps());
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INPUT_INVALID");
  });

  test("omitted input defaults to an empty object and still fails the required check", async () => {
    const out = await invokeSavedTool({ toolId: "t1" }, deps());
    expect(out.status === "refused" && out.code).toBe("ERR_TOOLGEN_INPUT_INVALID");
  });
});

describe("invokeSavedTool execution", () => {
  test("a successful call returns the result", async () => {
    const out = await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      deps({
        spawn: async () => ({
          call: async () => ({ ok: 1 }),
          close: async () => {},
          describe: async () => ({ name: "", description: "", inputSchema: {} }),
        }),
      }),
    );
    expect(out.status).toBe("executed");
    expect(out.status === "executed" && out.result).toEqual({ ok: 1 });
  });

  test("a throwing tool body is `failed`, not `refused`", async () => {
    // The distinction is the point: "the gateway would not run it" and "it ran and broke" are
    // different facts and a script acts differently on each (spec §3.1).
    const out = await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      deps({
        spawn: async () => ({
          call: async () => {
            throw new Error("boom");
          },
          close: async () => {},
          describe: async () => ({ name: "", description: "", inputSchema: {} }),
        }),
      }),
    );
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.error).toContain("boom");
  });

  test("the handle is closed even when the call throws", async () => {
    let closed = 0;
    await invokeSavedTool(
      { toolId: "t1", input: { q: "x" } },
      deps({
        spawn: async () => ({
          call: async () => {
            throw new Error("boom");
          },
          close: async () => {
            closed += 1;
          },
          describe: async () => ({ name: "", description: "", inputSchema: {} }),
        }),
      }),
    );
    expect(closed).toBe(1);
  });

  test("concurrent invocations of the SAME tool id are serialised", async () => {
    // Guards spec §4.2: spawnSavedTool re-emits saved/<id>/index.ts on every spawn, so two
    // overlapping spawns write the same path and transiently EBUSY on Windows.
    let active = 0;
    let maxActive = 0;
    const d = deps({
      spawn: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        return {
          call: async () => {
            active -= 1;
            return "ok";
          },
          close: async () => {},
          describe: async () => ({ name: "", description: "", inputSchema: {} }),
        };
      },
    });
    await Promise.all([
      invokeSavedTool({ toolId: "t1", input: { q: "a" } }, d),
      invokeSavedTool({ toolId: "t1", input: { q: "b" } }, d),
    ]);
    expect(maxActive).toBe(1);
  });

  test("different tool ids are NOT serialised against each other", async () => {
    let active = 0;
    let maxActive = 0;
    // `invokeSavedTool` resolves through `savedTools()`, never `findArtifact()` (see the
    // "ephemeral" refusal test above) — so the fake registry must serve BOTH tool ids from
    // `savedTools()` for this test to reach spawn at all.
    const registry = {
      savedTools: () => [
        { toolId: "t1", artifact: ARTIFACT },
        { toolId: "t2", artifact: { ...ARTIFACT, toolId: "t2" } },
      ],
    };
    const d = deps({
      registry: registry as unknown as ToolgenInvokeDeps["registry"],
      spawn: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        return {
          call: async () => {
            active -= 1;
            return "ok";
          },
          close: async () => {},
          describe: async () => ({ name: "", description: "", inputSchema: {} }),
        };
      },
    });
    await Promise.all([
      invokeSavedTool({ toolId: "t1", input: { q: "a" } }, d),
      invokeSavedTool({ toolId: "t2", input: { q: "b" } }, d),
    ]);
    expect(maxActive).toBe(2);
  });
});

describe("serialise cleanup", () => {
  test("the per-tool-id chain entry is dropped once the last caller drains", async () => {
    const before = __chainsSizeForTest();
    const d = deps({
      registry: {
        savedTools: () => [{ toolId: "cleanup-test-t1", artifact: ARTIFACT }],
      } as unknown as ToolgenInvokeDeps["registry"],
      spawn: async () => ({
        call: async () => "ok",
        close: async () => {},
        describe: async () => ({ name: "", description: "", inputSchema: {} }),
      }),
    });
    const out = await invokeSavedTool({ toolId: "cleanup-test-t1", input: { q: "x" } }, d);
    // Assert the invocation actually RAN before asserting the cleanup. Every refusal returns
    // before `serialise` is ever called, so a future change that made this path refuse would
    // create no chain entry at all and the size assertion below would hold vacuously — passing
    // while proving nothing about the cleanup it is named for.
    expect(out.status).toBe("executed");
    // Let the cleanup microtask run: it is queued on the tail's `finally`, one turn after the
    // invocation's own promise resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(__chainsSizeForTest()).toBe(before);
  });
});
