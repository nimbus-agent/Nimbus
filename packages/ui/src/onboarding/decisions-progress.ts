// The Decisions onboarding step's words (role packs P5), as a pure function of what the gateway
// reports: `decisions.status` (what the pass read and found) and `connector.listStatus` (sync).
// Plain language first; every number is one the gateway counted under the brief's own rules.

export interface DecisionStatus {
  readonly enabled: boolean;
  readonly state: "idle" | "running" | "stopped" | "disabled";
  readonly lastPassAt: number | null;
  readonly minConfidence: number;
  readonly windowDays: number;
  readonly sources: readonly {
    readonly service: string;
    readonly type: string;
    readonly kind: string;
    readonly items: number;
  }[];
  readonly candidates: {
    readonly pending: number;
    readonly extracted: number;
    readonly vetoed: number;
  };
  readonly shown: number;
  readonly recent: readonly {
    readonly statement: string;
    readonly service: string;
    readonly at: number;
  }[];
}

export interface ConnectorProgress {
  readonly id: string;
  readonly displayName: string;
  /** `SyncStatus.status`. */
  readonly status: string;
  readonly itemCount: number;
  readonly lastSyncAt: number | null;
}

export type DecisionsPhase = "off" | "working" | "found" | "none";

export interface DecisionsView {
  readonly phase: DecisionsPhase;
  readonly syncLines: readonly string[];
  readonly headline: string;
  /** For `none`: why nothing qualified. */
  readonly reason?: string;
}

const NOUN: Readonly<Record<string, readonly [string, string]>> = {
  message: ["message", "messages"],
  ticket: ["ticket", "tickets"],
  doc: ["doc", "docs"],
  note: ["note", "notes"],
  commit: ["commit", "commits"],
};

function counted(n: number, kind: string): string {
  const [one, many] = NOUN[kind] ?? ["item", "items"];
  return `${String(n)} ${n === 1 ? one : many}`;
}

function nameOf(service: string, names: ReadonlyMap<string, string>): string {
  return names.get(service) ?? service;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

function syncLine(c: ConnectorProgress): string {
  const items = `${String(c.itemCount)} ${c.itemCount === 1 ? "item" : "items"}`;
  return c.status === "syncing"
    ? `Syncing ${c.displayName}… ${items}`
    : `${c.displayName}: ${items}`;
}

export function decisionsView(
  status: DecisionStatus | null,
  connectors: readonly ConnectorProgress[],
): DecisionsView {
  const syncLines = connectors.map(syncLine);
  if (status !== null && !status.enabled) {
    return {
      phase: "off",
      syncLines,
      headline: "The decisions pass is turned off in your config ([decisions] enabled).",
    };
  }
  const syncing = connectors.some((c) => c.status === "syncing" || c.lastSyncAt === null);
  if (status === null || status.state === "running" || syncing || status.candidates.pending > 0) {
    return {
      phase: "working",
      syncLines,
      headline: `Looking for decisions… ${String(status?.shown ?? 0)} found so far`,
    };
  }
  const shown = status.shown;
  if (shown > 0) {
    return {
      phase: "found",
      syncLines,
      headline: `${String(shown)} ${shown === 1 ? "decision" : "decisions"} found.`,
    };
  }
  const names = new Map(connectors.map((c) => [c.id, c.displayName]));
  const read = joinAnd(
    status.sources.map((s) => `${counted(s.items, s.kind)} from ${nameOf(s.service, names)}`),
  );
  if (read === "") {
    return {
      phase: "none",
      syncLines,
      headline: "Nothing has been read yet that could hold a decision.",
    };
  }
  const headline = `We read ${read} and found no clear decisions.`;
  const reason =
    status.candidates.extracted > 0
      ? `${String(status.candidates.extracted)} possible ${
          status.candidates.extracted === 1 ? "decision was" : "decisions were"
        } too uncertain to show (below your confidence floor).`
      : "None of it used decision language like 'we decided' or 'Decision:'.";
  return { phase: "none", syncLines, headline, reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate a `decisions.status` reply; anything else is "not answered yet". */
export function asDecisionStatus(v: unknown): DecisionStatus | null {
  if (!isRecord(v) || typeof v["enabled"] !== "boolean" || typeof v["shown"] !== "number") {
    return null;
  }
  const c = v["candidates"];
  if (
    !isRecord(c) ||
    typeof c["pending"] !== "number" ||
    typeof c["extracted"] !== "number" ||
    !Array.isArray(v["sources"]) ||
    !Array.isArray(v["recent"])
  ) {
    return null;
  }
  return v as unknown as DecisionStatus;
}
