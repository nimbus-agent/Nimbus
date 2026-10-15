import type { Database } from "bun:sqlite";

import {
  agentDecisionOwned,
  deleteAgentDecision,
  insertAgentDecision,
} from "../decisions/decision-store.ts";
import type { DecisionEvidence } from "../decisions/decision-types.ts";
import { unprojectTerm } from "../glossary/glossary-project.ts";
import {
  computeTermStats,
  deleteAgentTerm,
  termOwnership,
  upsertAgentTerm,
} from "../glossary/glossary-store.ts";
import { scoreTerm } from "../glossary/term-scoring.ts";
import {
  CAPTURED_RELATION_TYPES,
  deleteGraphRelation,
  graphRelationExists,
  resolveItemGraphEntityId,
  upsertGraphRelation,
} from "../graph/relationship-graph.ts";
import { clampBody } from "../index/body-caps.ts";
import { CaptureError, type CaptureKind, type NativeValidatedCapture } from "./capture-types.ts";

/**
 * Invariant I28's accept side: the ONLY caller of the agent-row writers (static D32(d)), itself
 * called only by `capture-gate.ts`. Every write here runs inside the gate's accept transaction, and
 * every inverse deletes only what the capture still OWNS (`capture_id`, spec § 5.3).
 */
export type NativeStatus = "owned" | "superseded" | "absent";

export interface LinkEndpoints {
  readonly fromEntityId: string;
  readonly toEntityId: string;
}

const ITEM_TITLE_MAX = 200;

export function resolveLinkEndpoints(
  db: Database,
  fromItemId: string,
  toItemId: string,
): LinkEndpoints {
  const fromEntityId = resolveItemGraphEntityId(db, fromItemId);
  if (fromEntityId === undefined) {
    throw new CaptureError(
      "ERR_CAPTURE_LINK_UNRESOLVED",
      `${fromItemId} is not in the relationship graph, so it cannot be linked`,
    );
  }
  const toEntityId = resolveItemGraphEntityId(db, toItemId);
  if (toEntityId === undefined) {
    throw new CaptureError(
      "ERR_CAPTURE_LINK_UNRESOLVED",
      `${toItemId} is not in the relationship graph, so it cannot be linked`,
    );
  }
  return { fromEntityId, toEntityId };
}

function termSuperseded(termKey: string): CaptureError {
  return new CaptureError(
    "ERR_CAPTURE_SUPERSEDED",
    `the glossary term "${termKey}" is defined in the owner's nimbus.toml (manual); that entry wins`,
  );
}

/**
 * Accept preconditions. A term refuses ONLY over a `manual` row (the owner's own config). A
 * `vetoed` row is the local model's classification ("not a domain term"), never the owner's: the
 * owner's explicit accept outranks it and takes the row over like any other.
 */
export function assertAcceptable(
  db: Database,
  v: NativeValidatedCapture,
): LinkEndpoints | undefined {
  if (v.kind === "term") {
    if (termOwnership(db, v.payload.termKey)?.definitionSource === "manual") {
      throw termSuperseded(v.payload.termKey);
    }
    return undefined;
  }
  if (v.kind === "link") return resolveLinkEndpoints(db, v.payload.fromItemId, v.payload.toItemId);
  return undefined;
}

export function renderAcceptedItem(v: NativeValidatedCapture): { title: string; body: string } {
  switch (v.kind) {
    case "note":
      return { title: v.payload.title, body: v.payload.body };
    case "decision": {
      const p = v.payload;
      const lines = [`Decision: ${p.statement}`, `Rationale: ${p.rationale ?? "(none given)"}`];
      if (p.alternatives.length > 0) lines.push(`Alternatives: ${p.alternatives.join(" · ")}`);
      return { title: clampBody(p.statement, ITEM_TITLE_MAX), body: lines.join("\n") };
    }
    case "term": {
      const p = v.payload;
      const lines = [`Term: ${p.term} — ${p.definition}`];
      if (p.synonyms.length > 0) lines.push(`Synonyms: ${p.synonyms.join(", ")}`);
      return { title: p.term, body: lines.join("\n") };
    }
    case "link": {
      const p = v.payload;
      const head = `Link: ${p.fromItemId} —${p.relation}→ ${p.toItemId}`;
      return {
        title: clampBody(head, ITEM_TITLE_MAX),
        body: p.note === null ? head : `${head}\nNote: ${p.note}`,
      };
    }
  }
}

function itemTitle(db: Database, itemId: string): string {
  const r = db.query("SELECT title FROM item WHERE id = ?").get(itemId) as {
    title: string | null;
  } | null;
  return r?.title ?? itemId;
}

export function writeCaptureNative(
  db: Database,
  p: {
    captureId: string;
    itemId: string;
    v: NativeValidatedCapture;
    link: LinkEndpoints | undefined;
    nowMs: number;
  },
): string {
  const { v } = p;
  switch (v.kind) {
    case "note":
      throw new Error("a note has no native row; it is live from submit");
    case "decision": {
      const id = `capture:${p.captureId}`;
      const evidence: DecisionEvidence[] = v.payload.evidence.map((itemId) => ({
        kind: "source",
        entityId: null,
        itemId,
        label: itemTitle(db, itemId),
        url: null,
        occurredAt: null,
      }));
      insertAgentDecision(db, {
        id,
        captureId: p.captureId,
        sourceItemId: p.itemId,
        statement: v.payload.statement,
        rationale: v.payload.rationale,
        alternatives: v.payload.alternatives,
        decidedAt: v.payload.decidedAt,
        evidence,
        nowMs: p.nowMs,
      });
      return id;
    }
    case "term": {
      const stats = computeTermStats(db, v.payload.termKey);
      const score = scoreTerm({
        docFreq: stats.docFreq,
        serviceSpread: stats.serviceSpread,
        form: "phrase",
      });
      const wrote = upsertAgentTerm(db, {
        termKey: v.payload.termKey,
        displayTerm: v.payload.term,
        definition: v.payload.definition,
        synonyms: v.payload.synonyms,
        captureId: p.captureId,
        stats,
        score,
        nowMs: p.nowMs,
      });
      if (!wrote) throw termSuperseded(v.payload.termKey);
      // The row may have been a projected llm/snippet term. Reconcile now skips agent rows, so
      // nothing else would ever remove that `nimbus:glossary_term` item, and it would keep serving
      // the superseded definition in search. Same transaction as the takeover.
      unprojectTerm(db, v.payload.termKey);
      return v.payload.termKey;
    }
    case "link": {
      if (p.link === undefined) throw new Error("link endpoints were not resolved");
      const type = CAPTURED_RELATION_TYPES[v.payload.relation];
      upsertGraphRelation(db, p.link.fromEntityId, p.link.toEntityId, type, p.nowMs);
      return `${p.link.fromEntityId}|${p.link.toEntityId}|${type}`;
    }
  }
}

function parseLinkRef(nativeRef: string): [string, string, string] | undefined {
  const parts = nativeRef.split("|");
  return parts.length === 3 ? [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""] : undefined;
}

export function revokeCaptureNative(
  db: Database,
  row: { id: string; kind: CaptureKind; nativeRef: string },
  linkNamedByAnotherAccepted: boolean,
): void {
  switch (row.kind) {
    case "note":
      return;
    case "decision":
      deleteAgentDecision(db, row.nativeRef, row.id);
      return;
    case "term":
      deleteAgentTerm(db, row.nativeRef, row.id);
      return;
    case "link": {
      // Two captures can name one (from, to, type) triple, and the graph stores ONE edge.
      if (linkNamedByAnotherAccepted) return;
      const ref = parseLinkRef(row.nativeRef);
      if (ref !== undefined) deleteGraphRelation(db, ...ref);
      return;
    }
    case "action":
      return;
  }
}

export function captureNativeStatus(
  db: Database,
  row: { id: string; kind: CaptureKind; nativeRef: string },
): NativeStatus {
  switch (row.kind) {
    case "note":
      return "absent";
    case "decision":
      return agentDecisionOwned(db, row.nativeRef, row.id) ? "owned" : "absent";
    case "term": {
      const o = termOwnership(db, row.nativeRef);
      if (o === null) return "absent";
      return o.captureId === row.id && o.definitionSource === "agent" ? "owned" : "superseded";
    }
    case "link": {
      const ref = parseLinkRef(row.nativeRef);
      return ref !== undefined && graphRelationExists(db, ...ref) ? "owned" : "absent";
    }
    case "action":
      return "absent";
  }
}
