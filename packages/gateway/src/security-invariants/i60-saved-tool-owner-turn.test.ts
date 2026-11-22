import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I60 - a saved generated tool reaches the model only on the owner's turn, each call approved by a person over its input", () => {
  test("the type is in the frozen HITL set, owner-only (never delegated) and shown by its prompt text", async () => {
    const { HITL_REQUIRED, isOwnerOnlyActionType, usesPromptText } = await import(
      "../engine/executor.ts"
    );
    const { TOOLGEN_MODEL_INVOKE_TYPE } = await import("../toolgen/toolgen-model-door.ts");
    expect(HITL_REQUIRED.has(TOOLGEN_MODEL_INVOKE_TYPE)).toBe(true);
    expect(isOwnerOnlyActionType(TOOLGEN_MODEL_INVOKE_TYPE)).toBe(true);
    expect(usesPromptText(TOOLGEN_MODEL_INVOKE_TYPE)).toBe(true);
  });

  test("the lock-off is a recognised policy capability, and an unreadable policy offers nothing", async () => {
    const { AI_V2_CAPABILITIES } = await import("../policy/types.ts");
    const door = await import("../toolgen/toolgen-model-door.ts");
    expect([...AI_V2_CAPABILITIES]).toContain(door.TOOLGEN_MODEL_ACCESS_CAPABILITY);
    const source = {
      config: () => ({ enabled: true, modelTools: ["t"] }),
      enforced: () => undefined,
      policyUnverified: () => false,
      registry: { savedTools: () => [{ toolId: "t" }] as never },
      savedDigest: () => "d",
      invoke: async () => {
        throw new Error("must not run");
      },
    };
    expect(door.listModelOfferableTools(source)).toEqual([]);
  });

  test("no approval in the request context: the call is refused and nothing runs", async () => {
    const door = await import("../toolgen/toolgen-model-door.ts");
    let ran = 0;
    const source = {
      config: () => ({ enabled: true, modelTools: ["t"] }),
      enforced: () => ({ capabilitiesDisabled: new Set<string>() }),
      policyUnverified: () => false,
      registry: { savedTools: () => [] },
      savedDigest: () => "d",
      invoke: async () => {
        ran += 1;
        return { status: "executed" as const, toolId: "t", result: 1, durationMs: 0 };
      },
    };
    expect(await door.invokeForModel(source, () => undefined, "t", {})).toEqual({
      refused: door.TOOLGEN_MODEL_REFUSALS.notOwner,
    });
    expect(ran).toBe(0);
  });

  test("a pinned spawn refuses bytes that do not hash to the approved digest", async () => {
    const { pinReadVerified } = await import("../toolgen/toolgen-model-door.ts");
    const { digestOfCanonicalBytes } = await import("../toolgen/toolgen-artifact.ts");
    const read = (async () => ({
      ok: true as const,
      canonicalJson: "{}",
      artifact: {} as never,
    })) as never;
    await expect(pinReadVerified(read, "0".repeat(64))("c", "t", "k")).rejects.toThrow(
      /not the one the owner approved/,
    );
    const ok = await pinReadVerified(read, digestOfCanonicalBytes("{}"))("c", "t", "k");
    expect(ok.ok).toBe(true);
    // A failed verification passes through unchanged (the spawn refuses it as before), never as "changed".
    const bad = (async () => ({
      ok: false as const,
      reason: "signature_mismatch" as const,
    })) as never;
    expect(await pinReadVerified(bad, "0".repeat(64))("c", "t", "k")).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("wiring: runAsk sets the approval on the owner's non-demo turn only; the agent offers on its presence; gateway-main omits the door in a demo root; assemble pins the spawn", async () => {
    const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const at = runAsk.indexOf("function offerConnectorWriteExecutorIfOwner(");
    const body = runAsk.slice(at, runAsk.indexOf("\n}\n", at));
    expect(body).toContain("p.offerConnectorWriteTools === true && !isDemo(p)");
    expect(body).toContain("store.toolgenModelAsk = createOwnerOnlyAsk(");
    expect(body).toContain("delete store.toolgenModelAsk");
    const withdraw = runAsk.slice(runAsk.indexOf("function withdrawOfferedExecutors("));
    expect(withdraw.slice(0, withdraw.indexOf("\n}\n"))).toContain("delete store.toolgenModelAsk");

    const agent = stripComments(await read("packages/gateway/src/engine/agent.ts"));
    expect(agent).toMatch(
      /deps\.toolgen === undefined \|\| getAgentRequestToolgenModelAsk\(\) === undefined\s*\?\s*\{\}\s*:\s*buildModelGeneratedTools\(/,
    );
    // A refused, failed or unrecorded call is logged as an error, never as ok.
    expect(agent).toContain("wrapToolForLlm(service, tool, def, deps.auditDb, isModelCallNotOk)");

    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toContain(
      "...(platform.paths.demo === true ? {} : { toolgen: platform.toolgenModelDoor })",
    );

    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    const door = assemble.slice(assemble.indexOf("const toolgenModelDoor: ToolgenModelDoorSource"));
    expect(door).toContain("spawn: (id) => spawnSaved(id, pin)");
    expect(door).toContain(
      "policyUnverified: () => policyGate.governanceIntended() && !policyGate.status().signatureValid",
    );
    const spawn = assemble.slice(assemble.indexOf("const spawnSaved = async ("));
    expect(spawn.slice(0, spawn.indexOf("\n  };\n"))).toContain(
      "if (pin !== undefined && !pin.stillAllowed())",
    );
    expect(door).toContain("approvalAuditId: pin.approvalAuditId");
  });
});
