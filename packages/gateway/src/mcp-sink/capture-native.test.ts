import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { listDecisions } from "../decisions/decision-store.ts";
import { projectTerm } from "../glossary/glossary-project.ts";
import {
  computeTermStats,
  getTerm,
  markConsolidated,
  markVetoed,
  upsertCandidate,
  upsertManualTerm,
} from "../glossary/glossary-store.ts";
import { graphRelationExists } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import {
  assertAcceptable,
  captureNativeStatus,
  type LinkEndpoints,
  renderAcceptedItem,
  resolveLinkEndpoints,
  revokeCaptureNative,
  writeCaptureNative,
} from "./capture-native.ts";
import type {
  DecisionPayload,
  LinkPayload,
  TermPayload,
  ValidatedCapture,
} from "./capture-types.ts";

let db: Database;
const NOW = 1_700_000_000_000;

function addPr(n: number): string {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `acme/app#${n}`,
    title: `PR ${n}`,
    bodyPreview: "patch",
    modifiedAt: NOW,
    syncedAt: NOW,
    metadata: { repo: "acme/app" },
  });
  const r = db.query("SELECT id FROM item WHERE external_id = ?").get(`acme/app#${n}`) as {
    id: string;
  };
  return r.id;
}

function addCaptureItem(): string {
  upsertIndexedItem(db, {
    service: "nimbus",
    type: "capture",
    externalId: "cap_x",
    title: "cap",
    bodyPreview: "cap",
    modifiedAt: NOW,
    syncedAt: NOW,
  });
  const r = db.query("SELECT id FROM item WHERE external_id = 'cap_x'").get() as { id: string };
  return r.id;
}

const decision = (over: Partial<DecisionPayload> = {}): ValidatedCapture => ({
  kind: "decision",
  payload: {
    statement: "Use WAL",
    rationale: "faster",
    alternatives: [],
    decidedAt: NOW,
    evidence: [],
    ...over,
  },
});
const term = (over: Partial<TermPayload> = {}): ValidatedCapture => ({
  kind: "term",
  payload: { term: "WAL", termKey: "wal", definition: "write-ahead log", synonyms: [], ...over },
});
const link = (from: string, to: string, over: Partial<LinkPayload> = {}): ValidatedCapture => ({
  kind: "link",
  payload: { fromItemId: from, toItemId: to, relation: "fixes", note: null, ...over },
});

beforeEach(() => {
  db = openMigratedMemoryDb();
});

function seedLlmTerm(project: boolean): void {
  upsertCandidate(db, {
    key: "wal",
    surface: "WAL",
    form: "phrase",
    stats: computeTermStats(db, "wal"),
    score: 1,
    nowMs: NOW,
  });
  markConsolidated(db, {
    termKey: "wal",
    definition: "old def",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs: NOW,
  });
  if (!project) return;
  const t = getTerm(db, "wal");
  if (t === null) throw new Error("seed failed");
  projectTerm(db, t, NOW);
}

describe("decision", () => {
  test("write, status, revoke", () => {
    const prId = addPr(1);
    const itemId = addCaptureItem();
    const ref = writeCaptureNative(db, {
      captureId: "cap_1",
      itemId,
      v: decision({ evidence: [prId, "missing-item"] }),
      link: undefined,
      nowMs: NOW,
    });
    expect(ref).toBe("capture:cap_1");
    const rows = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.extractionSource).toBe("agent");
    expect(rows[0]?.evidence.map((e) => e.label).sort()).toEqual(["PR 1", "missing-item"]);
    const row = { id: "cap_1", kind: "decision" as const, nativeRef: ref };
    expect(captureNativeStatus(db, row)).toBe("owned");
    revokeCaptureNative(db, row, false);
    expect(captureNativeStatus(db, row)).toBe("absent");
    expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(0);
  });
});

describe("term", () => {
  const write = (captureId: string, v = term()) =>
    writeCaptureNative(db, { captureId, itemId: "i", v, link: undefined, nowMs: NOW });

  function projectedCount(): number {
    return (
      db
        .query("SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus' AND type = 'glossary_term'")
        .get() as { n: number }
    ).n;
  }

  test("assertAcceptable refuses a manual row, passes llm, model-vetoed and absent", () => {
    expect(assertAcceptable(db, term())).toBeUndefined();
    seedLlmTerm(false);
    expect(assertAcceptable(db, term())).toBeUndefined();
    // A veto is the local model's classification, not the owner's: the owner's accept outranks it.
    markVetoed(db, "wal", NOW);
    expect(getTerm(db, "wal")?.status).toBe("vetoed"); // positive control
    expect(assertAcceptable(db, term())).toBeUndefined();
    upsertManualTerm(db, {
      termKey: "man",
      displayTerm: "MAN",
      definition: "mine",
      synonyms: [],
      nearMisses: [],
      stats: computeTermStats(db, "man"),
      score: 0,
      nowMs: NOW,
    });
    expect(() => assertAcceptable(db, term({ term: "MAN", termKey: "man" }))).toThrow(
      /ERR_CAPTURE_SUPERSEDED/,
    );
  });

  test("takeover unprojects the llm projection", () => {
    seedLlmTerm(true);
    expect(projectedCount()).toBe(1); // positive control
    expect(write("cap_1")).toBe("wal");
    expect(projectedCount()).toBe(0);
  });

  test("a refused write (manual after the check) throws and leaves the projection alone", () => {
    seedLlmTerm(true);
    assertAcceptable(db, term());
    upsertManualTerm(db, {
      termKey: "wal",
      displayTerm: "WAL",
      definition: "mine",
      synonyms: [],
      nearMisses: [],
      stats: computeTermStats(db, "wal"),
      score: 0,
      nowMs: NOW,
    });
    const projectedBefore = projectedCount();
    expect(() => write("cap_1")).toThrow(/ERR_CAPTURE_SUPERSEDED.*nimbus\.toml/);
    expect(projectedCount()).toBe(projectedBefore);
    expect(getTerm(db, "wal")?.definition).toBe("mine");
  });

  test("a model-vetoed key is taken over by the accept, then revoke deletes it", () => {
    seedLlmTerm(false);
    markVetoed(db, "wal", NOW);
    expect(getTerm(db, "wal")?.status).toBe("vetoed"); // positive control
    expect(write("cap_1")).toBe("wal");
    const t = getTerm(db, "wal");
    expect(t?.status).toBe("consolidated");
    expect(t?.definitionSource).toBe("agent");
    const row = { id: "cap_1", kind: "term" as const, nativeRef: "wal" };
    expect(captureNativeStatus(db, row)).toBe("owned");
    revokeCaptureNative(db, row, false);
    expect(getTerm(db, "wal")).toBeNull();
  });

  test("supersession and revoke ownership", () => {
    write("cap_1");
    const r1 = { id: "cap_1", kind: "term" as const, nativeRef: "wal" };
    const r2 = { id: "cap_2", kind: "term" as const, nativeRef: "wal" };
    expect(captureNativeStatus(db, r1)).toBe("owned");
    write("cap_2", term({ definition: "newer" }));
    expect(captureNativeStatus(db, r1)).toBe("superseded");
    expect(captureNativeStatus(db, r2)).toBe("owned");
    revokeCaptureNative(db, r1, false);
    expect(getTerm(db, "wal")?.definition).toBe("newer");
    revokeCaptureNative(db, r2, false);
    expect(getTerm(db, "wal")).toBeNull();
    expect(captureNativeStatus(db, r2)).toBe("absent");
  });

  test("a non-agent row reads as superseded", () => {
    seedLlmTerm(false);
    expect(captureNativeStatus(db, { id: "c", kind: "term", nativeRef: "wal" })).toBe("superseded");
  });
});

describe("link", () => {
  test("resolve refuses a capture item and an ungraphed id, naming it", () => {
    const a = addPr(1);
    const cap = addCaptureItem();
    expect(() => resolveLinkEndpoints(db, cap, a)).toThrow(
      new RegExp(`ERR_CAPTURE_LINK_UNRESOLVED.*${cap}`),
    );
    expect(() => resolveLinkEndpoints(db, a, "nope")).toThrow(/nope/);
    expect(() => assertAcceptable(db, link(a, "nope"))).toThrow(/ERR_CAPTURE_LINK_UNRESOLVED/);
  });

  test("write, status and the shared-edge revoke guard", () => {
    const v = link(addPr(1), addPr(2));
    const ends: LinkEndpoints | undefined = assertAcceptable(db, v);
    if (ends === undefined) throw new Error("expected endpoints");
    const ref = writeCaptureNative(db, {
      captureId: "cap_1",
      itemId: "i",
      v,
      link: ends,
      nowMs: NOW,
    });
    expect(ref).toBe(`${ends.fromEntityId}|${ends.toEntityId}|captured_fixes`);
    const row = { id: "cap_1", kind: "link" as const, nativeRef: ref };
    expect(captureNativeStatus(db, row)).toBe("owned");
    revokeCaptureNative(db, row, true);
    expect(graphRelationExists(db, ends.fromEntityId, ends.toEntityId, "captured_fixes")).toBe(
      true,
    );
    revokeCaptureNative(db, row, false);
    expect(captureNativeStatus(db, row)).toBe("absent");
    const bad = { ...row, nativeRef: "garbage" };
    revokeCaptureNative(db, bad, false);
    expect(captureNativeStatus(db, bad)).toBe("absent");
  });

  test("writing without resolved endpoints throws", () => {
    expect(() =>
      writeCaptureNative(db, {
        captureId: "c",
        itemId: "i",
        v: link("a", "b"),
        link: undefined,
        nowMs: NOW,
      }),
    ).toThrow(/not resolved/);
  });
});

describe("note", () => {
  test("has no native row", () => {
    const note = decisionAsNote();
    expect(() =>
      writeCaptureNative(db, { captureId: "c", itemId: "i", v: note, link: undefined, nowMs: NOW }),
    ).toThrow(/no native row/);
    const row = { id: "c", kind: "note" as const, nativeRef: "" };
    expect(() => revokeCaptureNative(db, row, false)).not.toThrow();
    expect(captureNativeStatus(db, row)).toBe("absent");
    expect(assertAcceptable(db, note)).toBeUndefined();
    expect(renderAcceptedItem(note)).toEqual({ title: "T", body: "B" });
  });
});

function decisionAsNote(): ValidatedCapture {
  return { kind: "note", payload: { title: "T", body: "B" } } as unknown as ValidatedCapture;
}

describe("renderAcceptedItem", () => {
  test("decision", () => {
    const bare = renderAcceptedItem(decision({ rationale: null }));
    expect(bare.title).toBe("Use WAL");
    expect(bare.body).toContain("Decision: Use WAL");
    expect(bare.body).toContain("Rationale: (none given)");
    expect(bare.body).not.toContain("Alternatives:");
    const full = renderAcceptedItem(decision({ alternatives: ["a", "b"] }));
    expect(full.body).toContain("Rationale: faster");
    expect(full.body).toContain("Alternatives: a · b");
  });
  test("term", () => {
    expect(renderAcceptedItem(term()).body).toBe("Term: WAL — write-ahead log");
    expect(renderAcceptedItem(term({ synonyms: ["x", "y"] })).body).toContain("Synonyms: x, y");
  });
  test("link", () => {
    expect(renderAcceptedItem(link("a", "b")).body).toBe("Link: a —fixes→ b");
    expect(renderAcceptedItem(link("a", "b", { note: "why" })).body).toContain("\nNote: why");
  });
});
