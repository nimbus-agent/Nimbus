import { z } from "zod";

import type { IpcCallable } from "./client-surface.ts";
import { type AdapterDeps, runTool, type ToolResult } from "./tool-runtime.ts";

/**
 * MCP WRITE tools (spec 2026-10-11 § 6, invariant I28). Never imports adapter.ts (the agent-tools
 * rule: no runtime import cycle). Registered only when the gateway's `capture.status` says the
 * sink is enabled for the kind — see `captureToolsFor`.
 */
type CaptureToolKind = "note" | "decision" | "term" | "link" | "action";

export interface CaptureToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, z.core.$ZodType>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: false;
    readonly idempotentHint: false;
    readonly openWorldHint: false;
  };
  /** `status` is not a capture kind: `capture_status` is offered whenever any kind is enabled. */
  readonly kind: CaptureToolKind | "status";
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

async function submitRaw(
  c: IpcCallable,
  kind: CaptureToolKind,
  payload: Record<string, unknown>,
  clientLabel: () => string | undefined,
): Promise<unknown> {
  const params: Record<string, unknown> = { kind, payload };
  const label = clientLabel();
  if (label !== undefined) {
    params["clientLabel"] = label;
  }
  return c.call<unknown>("capture.submit", params);
}

async function submit(
  c: IpcCallable,
  kind: CaptureToolKind,
  payload: Record<string, unknown>,
  clientLabel: () => string | undefined,
): Promise<string> {
  return idOf(await submitRaw(c, kind, payload, clientLabel));
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
        const payload: Record<string, unknown> = {
          title: args["title"],
          body: args["body"],
          ...pick(args, ["tags", "relatesTo"]),
        };
        const id = await submit(c, "note", payload, clientLabel);
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
      "A term the owner defined in nimbus.toml cannot be overridden.",
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
  {
    name: "propose_action",
    kind: "action",
    // `captureToolsFor` appends this machine's proposable action types to the description.
    description:
      "Propose a connector action (post a message, create or update a ticket, send an email, …) for the " +
      "user to approve. NOTHING is sent when you call this: the proposal waits on the user's machine " +
      "until the owner runs `nimbus captures accept <id>` and approves the exact input shown. It expires " +
      "if not accepted in time. Poll its outcome with capture_status. input is the tool's arguments as " +
      "a JSON object. Proposable action types on this machine: ",
    schema: {
      actionType: z.string(),
      input: z.record(z.string(), z.unknown()),
      summary: z.string(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) => {
        const raw = await submitRaw(
          c,
          "action",
          pick(args, ["actionType", "input", "summary"]),
          clientLabel,
        );
        const id = idOf(raw);
        const exp = (raw as Record<string, unknown>)["expiresAt"];
        const when = typeof exp === "number" ? new Date(exp).toISOString() : "its TTL";
        return {
          content: [
            {
              type: "text",
              text: `Proposed action ${id} — expires ${when}. It has NOT run: the owner must accept it with \`nimbus captures accept ${id}\` and approve the prompt. Poll capture_status with this id. Do not tell the user it was sent.`,
            },
          ],
        };
      }),
  },
  {
    name: "capture_status",
    kind: "status",
    description:
      "Read the state of a capture YOU submitted, by its id (proposed, executed, failed, rejected, " +
      "expired, accepted, live, revoked). Returns the state and, for an executed action, a short link " +
      "when the service returned one — never the payload.",
    schema: { id: z.string() },
    annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: true },
    run: (deps, args) =>
      runTool(deps, async (c: IpcCallable) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(await c.call<unknown>("capture.state", { id: args["id"] })),
          },
        ],
      })),
  },
];

function enabledKinds(r: Record<string, unknown>): readonly string[] {
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
  let status: Record<string, unknown>;
  try {
    const raw = await client.call<unknown>("capture.status", {});
    status = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    return [];
  }
  const kinds = enabledKinds(status);
  if (kinds.length === 0) return [];
  // The act door has its own switch (policy `mcp_action` included): `"action"` in kinds alone
  // is not enough, so propose_action follows `actionEnabled`, never the kinds list.
  const actionOn = status["actionEnabled"] === true;
  const types = Array.isArray(status["proposableActionTypes"])
    ? status["proposableActionTypes"].filter((t): t is string => typeof t === "string")
    : [];
  return CAPTURE_TOOL_SPECS.flatMap((s): CaptureToolSpec[] => {
    if (s.kind === "status") return [s];
    if (s.kind === "action") {
      return actionOn
        ? [
            {
              ...s,
              description: `${s.description}${types.length === 0 ? "(none configured)" : types.join(", ")}.`,
            },
          ]
        : [];
    }
    return kinds.includes(s.kind) ? [s] : [];
  });
}
