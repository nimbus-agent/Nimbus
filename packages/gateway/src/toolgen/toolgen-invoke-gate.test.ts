import { describe, expect, test } from "bun:test";
import { invokeSavedTool, type ToolgenInvokeDeps } from "./toolgen-invoke-gate.ts";

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
