import { z } from "zod";

import type { IpcCallable } from "./client-surface.ts";
import { type AdapterDeps, runTool, type ToolResult } from "./tool-runtime.ts";

/**
 * MCP WRITE tools (spec 2026-10-11 § 6, invariant I28). Never imports adapter.ts (the agent-tools
 * rule: no runtime import cycle). Registered only when the gateway's `capture.status` says the
 * sink is enabled for the kind — see `captureToolsFor`.
 */
type CaptureToolKind = "note" | "decision" | "term" | "link";

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
  readonly kind: CaptureToolKind;
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

async function submit(
  c: IpcCallable,
  kind: CaptureToolKind,
  payload: Record<string, unknown>,
  clientLabel: () => string | undefined,
): Promise<string> {
  const params: Record<string, unknown> = { kind, payload };
  const label = clientLabel();
  if (label !== undefined) {
    params["clientLabel"] = label;
  }
  return idOf(await c.call<unknown>("capture.submit", params));
}

/** Copy only the keys the caller actually sent, so an omitted optional is absent, not undefined. */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (args[k] !== undefined) {
      out[k] = args[k];
    }
  }
  return out;
}

function proposed(noun: string, id: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Proposed ${noun} ${id}. It is NOT recorded yet: it appears nowhere until the owner runs \`nimbus captures accept ${id}\`. Do not tell the user it has been recorded.`,
      },
    ],
  };
}

const PROPOSAL_NOTE =
  "Stored on the user's machine (nothing leaves it), labelled agent-authored, and INERT until the " +
  "owner reviews it: it is not searchable and appears in no brief until accepted. ";

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
  {
    name: "propose_decision",
    kind: "decision",
    description:
      "Propose a decision for the user's LOCAL Nimbus decision log. " +
      PROPOSAL_NOTE +
      "evidence takes item ids exactly as the `id` field a read tool returned; decidedAt is an ISO 8601 date.",
    schema: {
      statement: z.string(),
      rationale: z.string().optional(),
      alternatives: z.array(z.string()).optional(),
      decidedAt: z.string().optional(),
      evidence: z.array(z.string()).optional(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) => {
        const payload = pick(args, ["statement", "rationale", "alternatives", "evidence"]);
        const decidedAt = args["decidedAt"];
        if (typeof decidedAt === "string") {
          const ms = Date.parse(decidedAt);
          if (Number.isNaN(ms)) {
            throw new Error("decidedAt must be an ISO 8601 date");
          }
          payload["decidedAt"] = ms;
        }
        return proposed("decision", await submit(c, "decision", payload, clientLabel));
      }),
  },
  {
    name: "propose_term",
    kind: "term",
    description:
      "Propose a glossary term for the user's LOCAL Nimbus glossary. " +
      PROPOSAL_NOTE +
      "A term the owner vetoed or defined in nimbus.toml cannot be overridden.",
    schema: {
      term: z.string(),
      definition: z.string(),
      synonyms: z.array(z.string()).optional(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) =>
        proposed(
          "glossary term",
          await submit(c, "term", pick(args, ["term", "definition", "synonyms"]), clientLabel),
        ),
      ),
  },
  {
    name: "propose_link",
    kind: "link",
    description:
      "Propose a typed link between two indexed items in the user's LOCAL Nimbus relationship graph. " +
      PROPOSAL_NOTE +
      "Both ids must be the `id` field a read tool returned, and both items must be in the graph (a note captured over MCP is not).",
    schema: {
      fromItemId: z.string(),
      toItemId: z.string(),
      relation: z.enum(["relates_to", "fixes", "caused_by", "supersedes", "documents"]),
      note: z.string().optional(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) =>
        proposed(
          "link",
          await submit(
            c,
            "link",
            pick(args, ["fromItemId", "toItemId", "relation", "note"]),
            clientLabel,
          ),
        ),
      ),
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
