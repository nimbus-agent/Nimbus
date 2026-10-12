import { z } from "zod";

import type { IpcCallable } from "./client-surface.ts";
import { type AdapterDeps, runTool, type ToolResult } from "./tool-runtime.ts";

/**
 * MCP WRITE tools (spec 2026-10-11 § 6, invariant I28). Never imports adapter.ts (the agent-tools
 * rule: no runtime import cycle). Registered only when the gateway's `capture.status` says the
 * sink is enabled for the kind — see `captureToolsFor`.
 */
export interface CaptureToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, z.core.$ZodType>;
  readonly annotations: {
    readonly readOnlyHint: false;
    readonly destructiveHint: false;
    readonly idempotentHint: false;
    readonly openWorldHint: false;
  };
  readonly kind: "note";
  run(
    deps: AdapterDeps,
    args: Record<string, unknown>,
    clientLabel: () => string | undefined,
  ): Promise<ToolResult>;
}

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function idOf(v: unknown): string {
  const id = typeof v === "object" && v !== null ? (v as Record<string, unknown>)["id"] : undefined;
  if (typeof id !== "string") {
    throw new Error("gateway returned no capture id");
  }
  return id;
}

export const CAPTURE_TOOL_SPECS: readonly CaptureToolSpec[] = [
  {
    name: "capture_note",
    kind: "note",
    description:
      "Save a note into the user's LOCAL Nimbus index (stored on their machine; nothing leaves it). " +
      "The note is searchable immediately via searchIndex and is labelled agent-authored. " +
      "relatesTo takes item ids exactly as the `id` field returned by searchIndex or another read tool. " +
      "The user can revoke any note with `nimbus captures revoke <id>`.",
    // Never stricter than the gateway, which is authoritative and truncates prose itself.
    schema: {
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      relatesTo: z.array(z.string()).optional(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) => {
        const payload: Record<string, unknown> = { title: args["title"], body: args["body"] };
        if (args["tags"] !== undefined) {
          payload["tags"] = args["tags"];
        }
        if (args["relatesTo"] !== undefined) {
          payload["relatesTo"] = args["relatesTo"];
        }
        const label = clientLabel();
        const params: Record<string, unknown> = { kind: "note", payload };
        if (label !== undefined) {
          params["clientLabel"] = label;
        }
        const id = idOf(await c.call<unknown>("capture.submit", params));
        return {
          content: [
            {
              type: "text",
              text: `Captured note ${id}. It is stored locally, searchable now, and labelled agent-authored. The owner can revoke it with \`nimbus captures revoke ${id}\`.`,
            },
          ],
        };
      }),
  },
];

function enabledKinds(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const r = raw as Record<string, unknown>;
  if (r["enabled"] !== true || !Array.isArray(r["kinds"])) {
    return [];
  }
  return r["kinds"].filter((k): k is string => typeof k === "string");
}

/**
 * Decide which capture tools to register. Unlike `agentToolsSupported`, a gateway that is DOWN
 * yields NONE: an unreachable gateway cannot say the sink is on, and a write tool must never be
 * offered on a guess. A failed `session.declareKind` also yields none, because the gateway would
 * not see this connection as `mcp` and would refuse every submit.
 */
export async function captureToolsFor(deps: AdapterDeps): Promise<readonly CaptureToolSpec[]> {
  let client: IpcCallable;
  try {
    client = await deps.getClient();
  } catch {
    return [];
  }
  if (deps.agentToolsDisabledReason?.() !== undefined) {
    return [];
  }
  let kinds: readonly string[];
  try {
    kinds = enabledKinds(await client.call<unknown>("capture.status", {}));
  } catch {
    return [];
  }
  return CAPTURE_TOOL_SPECS.filter((s) => kinds.includes(s.kind));
}
