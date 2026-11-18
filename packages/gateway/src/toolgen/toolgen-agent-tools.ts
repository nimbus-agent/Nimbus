import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { SavedToolEnvelope } from "./toolgen-registry.ts";
import { zodSchemaFromInputSchema } from "./toolgen-schema.ts";

/**
 * The model-facing surface for generated tools (S4, I60, static D51).
 *
 * Takes the tools to offer as a LIST the caller already filtered (`listModelOfferableTools` in
 * `toolgen/toolgen-model-door.ts`: saved, opted in by id, every switch allowing), never a registry:
 * this function decides nothing about WHICH tools reach the model. An empty list contributes `{}`
 * -- NO tool at all, not a disabled tool that errors when called -- mirroring
 * `buildComputerUseTools`.
 *
 * `invoke` is the door's own call path (the owner's per-call approval, then `invokeSavedTool`); the
 * tool built here never spawns anything itself.
 */
export function buildGeneratedTools(
  offered: readonly SavedToolEnvelope[],
  invoke: (toolId: string, args: Record<string, unknown>) => Promise<unknown>,
  /**
   * The I11 envelope wrapper, INJECTED because `agent.ts`'s `wrapToolForLlm` is module-private.
   * Passing it in beats exporting it: a generated tool returns a remote API's response verbatim
   * into the model's context, so it is the single most injection-prone tool surface in the tree and
   * MUST NOT be constructible without the envelope. A required parameter makes that a compile
   * error rather than a review comment.
   */
  wrap: <T>(service: string, tool: string, def: T) => T,
  /** The description the model reads (the door's closer-escaped form of the owner's text). */
  describe: (envelope: SavedToolEnvelope) => string,
): ToolsInput {
  const out: ToolsInput = {};
  for (const envelope of offered) {
    const { toolId, inputSchema } = envelope.artifact;
    out[toolId] = wrap(
      "toolgen",
      toolId,
      createTool({
        id: toolId,
        description: describe(envelope),
        inputSchema: zodSchemaFromInputSchema(inputSchema),
        execute: async (input: unknown) => await invoke(toolId, input as Record<string, unknown>),
      }),
    );
  }
  return out;
}
