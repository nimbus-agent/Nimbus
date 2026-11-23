import type { Database } from "bun:sqlite";

import { writeToolCallLog } from "../../../db/tool-call-log.ts";
import { getAgentRequestSessionId } from "../../../engine/agent-request-context.ts";
import { wrapToolOutput } from "../../../engine/tool-output-envelope.ts";

/**
 * The model-facing wrapper of `LazyConnectorMesh.listTools` (I11): every tool's result is wrapped in
 * the `<tool_output>` envelope and, when `auditDb` is given, recorded in `tool_call_log` (success or
 * failure). Takes the merged dispatcher map and rewrites it in place; moved verbatim out of `mesh.ts`.
 */
export function wrapToolsWithEnvelopeAndAudit(
  merged: Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>,
  auditDb: Database | undefined,
): void {
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (value === undefined) continue;
    const inner = value.execute;
    if (inner === undefined) continue;
    const service = key.split("_")[0] ?? "mcp";
    merged[key] = {
      execute: async (input: unknown, ctx?: unknown): Promise<string> => {
        const sessionId = getAgentRequestSessionId() ?? null;
        const calledAt = Date.now();
        let status: "ok" | "error" = "ok";
        let envelope: string;
        try {
          const raw = await inner(input, ctx);
          envelope = wrapToolOutput({ service, tool: key }, raw);
        } catch (err) {
          status = "error";
          envelope = wrapToolOutput({ service, tool: key }, { error: String(err) });
          if (auditDb !== undefined) {
            writeToolCallLog(auditDb, {
              sessionId,
              toolId: key,
              service,
              calledAt,
              durationMs: Date.now() - calledAt,
              resultEnvelope: envelope,
              status,
              params: input,
            });
          }
          throw err;
        }
        if (auditDb !== undefined) {
          writeToolCallLog(auditDb, {
            sessionId,
            toolId: key,
            service,
            calledAt,
            durationMs: Date.now() - calledAt,
            resultEnvelope: envelope,
            status,
            params: input,
          });
        }
        return envelope;
      },
    };
  }
}
