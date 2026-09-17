import { describe, expect, test } from "bun:test";

import { NO_DUAL_VECTORS } from "../embedding/embedding-readiness.ts";
import {
  describeRetrieval,
  retrievalFromOutcome,
  retrievalNoteFor,
  type SearchRetrieval,
  unrankedReasonFor,
  unrankedRetrieval,
} from "./search-retrieval.ts";

const vec = new Float32Array([1]);

describe("unrankedReasonFor", () => {
  test("follows the hybrid branch condition in order", () => {
    expect(unrankedReasonFor({ nameQ: "q", semanticOn: false, hasRuntime: true })).toBe(
      "semantic_off",
    );
    expect(unrankedReasonFor({ nameQ: "", semanticOn: true, hasRuntime: true })).toBe("no_query");
    expect(unrankedReasonFor({ nameQ: "q", semanticOn: true, hasRuntime: false })).toBe(
      "no_embedding_runtime",
    );
    expect(unrankedReasonFor({ nameQ: "q", semanticOn: true, hasRuntime: true })).toBe(
      "vec_unavailable",
    );
  });
});

describe("retrievalFromOutcome", () => {
  test("a real vector is vector-ranked with no reason", () => {
    const r = retrievalFromOutcome(
      { vectors: { ...NO_DUAL_VECTORS, vec384: vec, model384: "m" }, degraded: null },
      null,
    );
    expect(r).toEqual({ vectorRanked: true, reason: null, partial: null, backfill: null });
  });

  test("an empty outcome carries the TEMPORARY reason when there is one", () => {
    expect(
      retrievalFromOutcome({ vectors: NO_DUAL_VECTORS, degraded: "timeout" }, null).reason,
    ).toBe("timeout");
    expect(
      retrievalFromOutcome({ vectors: NO_DUAL_VECTORS, degraded: "warming" }, null).reason,
    ).toBe("warming");
  });

  test("an empty outcome with no temporary reason is the permanent `unavailable`", () => {
    const r = retrievalFromOutcome({ vectors: NO_DUAL_VECTORS, degraded: null }, null);
    expect(r.vectorRanked).toBe(false);
    expect(r.reason).toBe("unavailable");
  });

  test("a one-dimension result keeps its partial marker; the backfill pass passes through", () => {
    const r = retrievalFromOutcome(
      {
        vectors: { ...NO_DUAL_VECTORS, vec384: vec, model384: "m", partial: "remote_timeout" },
        degraded: null,
      },
      { done: 3, total: 10 },
    );
    expect(r).toEqual({
      vectorRanked: true,
      reason: null,
      partial: "remote_timeout",
      backfill: { done: 3, total: 10 },
    });
  });
});

describe("describeRetrieval", () => {
  test("says nothing for a complete vector-ranked search, or when the caller chose keyword-only", () => {
    expect(
      describeRetrieval({ vectorRanked: true, reason: null, partial: null, backfill: null }),
    ).toEqual([]);
    expect(describeRetrieval(unrankedRetrieval("semantic_off", null))).toEqual([]);
    expect(describeRetrieval(unrankedRetrieval("no_query", null))).toEqual([]);
  });

  test("names every degradation, so none can read as a complete result", () => {
    for (const reason of [
      "no_embedding_runtime",
      "vec_unavailable",
      "warming",
      "timeout",
      "unavailable",
    ] as const) {
      const r: SearchRetrieval = { vectorRanked: false, reason, partial: null, backfill: null };
      const [note] = describeRetrieval(r);
      expect(note).toContain("keyword-only");
    }
    expect(
      describeRetrieval({
        vectorRanked: false,
        reason: "timeout",
        partial: null,
        backfill: null,
      })[0],
    ).toContain("timed out");
  });

  test("words backfill as progress of THIS pass, never as index coverage", () => {
    const [note] = describeRetrieval(
      unrankedRetrieval("semantic_off", { done: 8400, total: 51600 }),
    );
    expect(note).toContain("8,400 of 51,600 items processed this pass");
    expect(note).toContain("nimbus index health");
    expect(note).not.toContain("coverage 8,400");
  });

  test("retrievalNoteFor omits the field entirely when there is nothing to say", () => {
    expect(
      retrievalNoteFor({ vectorRanked: true, reason: null, partial: null, backfill: null }),
    ).toEqual({});
    expect(
      retrievalNoteFor({
        vectorRanked: true,
        reason: null,
        partial: "local_timeout",
        backfill: { done: 1, total: 2 },
      }).retrievalNote,
    ).toContain("; background embedding in progress");
  });
});
