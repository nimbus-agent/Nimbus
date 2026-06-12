import type { SynthesizedAnswer } from "./answer-synthesizer.ts";
import type { TribalCluster, TribalClusterStore } from "./cluster-store.ts";

const DAY_MS = 86_400_000;

// D19: these connector tool-id literals appear ONLY in this file (gateway side). The static audit
// (check-nimbus-invariants.ts) confines tribal KB writes to this gate — no other gateway module may
// name them. The destination (database/space/parent) is resolved from LOCAL CONFIG ONLY; a caller
// supplies at most a `--target` KB selector, never the destination itself (I25).
const NOTION_KB_TOOL = "notion_kb_append";
const CONFLUENCE_KB_TOOL = "confluence_kb_append";

export type CaptureTarget = "notion" | "confluence";

export interface WriteGateDeps {
  /** Destination config — resolved from local nimbus.toml only, never from the caller. */
  cfg: {
    notion?: { databaseId: string };
    confluence?: { spaceKey: string; parentPageId: string };
  };
  synthesize: (cluster: TribalCluster) => Promise<SynthesizedAnswer>;
  /** Submits the action through the executor HITL gate (I2). Approval fires the local owner's gate. */
  submitAction: (action: {
    type: string;
    payload: Record<string, unknown>;
  }) => Promise<{ status: "approved" | "rejected"; result?: { pageRef: string } }>;
  store: TribalClusterStore;
  cooldownDays: number;
  now: () => number;
}

export type CaptureResult =
  | { ok: true; pageRef: string }
  | { ok: false; error: "not_configured" | "target_ambiguous" | "rejected" | "write_failed" };

/** Resolve which KB to write to: an explicit selector, else the sole configured one, else error. */
function resolveTarget(
  cfg: WriteGateDeps["cfg"],
  requested: CaptureTarget | undefined,
): CaptureTarget | { error: "not_configured" | "target_ambiguous" } {
  const hasNotion = cfg.notion !== undefined;
  const hasConfluence = cfg.confluence !== undefined;
  if (requested !== undefined) {
    const configured = requested === "notion" ? hasNotion : hasConfluence;
    return configured ? requested : { error: "not_configured" };
  }
  if (hasNotion && hasConfluence) return { error: "target_ambiguous" };
  if (hasNotion) return "notion";
  if (hasConfluence) return "confluence";
  return { error: "not_configured" };
}

/**
 * The SOLE path from a capture trigger to a KB write (I25 / static D19). Resolves the destination
 * from local config only, synthesizes a draft, submits it through the executor HITL gate, and —
 * only on the owner's approval + a successful write — marks the cluster captured (entering cooldown).
 * The destination is NEVER taken from caller input; the caller supplies at most a `--target` selector.
 */
export async function captureToKnowledgeBase(
  deps: WriteGateDeps,
  cluster: TribalCluster,
  requested?: CaptureTarget,
): Promise<CaptureResult> {
  const target = resolveTarget(deps.cfg, requested);
  if (typeof target !== "string") return { ok: false, error: target.error };

  const draft = await deps.synthesize(cluster);
  const citationsJson = JSON.stringify(draft.citations);

  let action: { type: string; payload: Record<string, unknown> };
  if (target === "notion") {
    // Non-null: resolveTarget only returns "notion" when cfg.notion is defined.
    const dest = deps.cfg.notion as { databaseId: string };
    action = {
      type: "notion.knowledge.write",
      payload: {
        mcpToolId: NOTION_KB_TOOL,
        databaseId: dest.databaseId,
        title: draft.title,
        bodyMarkdown: draft.bodyMarkdown,
        citationsJson,
      },
    };
  } else {
    const dest = deps.cfg.confluence as { spaceKey: string; parentPageId: string };
    action = {
      type: "confluence.knowledge.write",
      payload: {
        mcpToolId: CONFLUENCE_KB_TOOL,
        spaceKey: dest.spaceKey,
        parentPageId: dest.parentPageId,
        title: draft.title,
        bodyMarkdown: draft.bodyMarkdown,
        citationsJson,
      },
    };
  }

  const outcome = await deps.submitAction(action);
  if (outcome.status === "rejected") return { ok: false, error: "rejected" };
  const pageRef = outcome.result?.pageRef;
  if (pageRef === undefined || pageRef === "") return { ok: false, error: "write_failed" };

  deps.store.markCaptured(cluster.clusterId, {
    now: deps.now(),
    pageRef,
    cooldownUntil: deps.now() + deps.cooldownDays * DAY_MS,
  });
  return { ok: true, pageRef };
}
