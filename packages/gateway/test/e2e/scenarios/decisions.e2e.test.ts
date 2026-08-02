import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { emitDecisionsBrief } from "../../../src/agents/decisions.ts";
import { runDecisionPass } from "../../../src/decisions/decision-extract.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

/** Narrows the `decisions.briefReady` payload instead of casting it into shape. */
function isBriefReadyParams(v: unknown): v is { brief: string; findings: { kind: string } } {
  if (v === null || typeof v !== "object") return false;
  const o = v as { brief?: unknown; findings?: unknown };
  if (typeof o.brief !== "string") return false;
  if (o.findings === null || typeof o.findings !== "object") return false;
  return typeof (o.findings as { kind?: unknown }).kind === "string";
}

describe("nimbus decisions (e2e, in-process)", () => {
  test("the decisions agent source is read-only", () => {
    // Anchored to this file, not the CWD — the sibling glossary.e2e.test.ts and
    // expert.e2e.test.ts do the same. A CWD-relative read resolves when the
    // suite starts at the repo root but throws ENOENT under the sharded
    // coverage runner, which starts elsewhere.
    const src = readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "agents", "decisions.ts"),
      "utf8",
    );
    expect(src).not.toContain("ToolExecutor");
    expect(src).not.toContain("HITL_REQUIRED");
    expect(src).not.toContain("connectors.dispatch");
  });

  test("seeded index -> pass -> brief: briefReady fires with markdown and a decisions-kind finding", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t = Date.now();

    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "thread-1",
      title: "billing thread",
      bodyPreview: "We decided to move billing to Postgres.",
      modifiedAt: t,
      syncedAt: t,
    });

    const summary = await runDecisionPass(db, {
      nowMs: t,
      useLlm: false,
      maxLlmCalls: 25,
      minConfidence: 0,
      retryCooldownMs: 1_000,
    });
    expect(summary.extracted).toBeGreaterThan(0);

    const seen: Array<{ method: string; params: unknown }> = [];
    await emitDecisionsBrief(
      {},
      { db, sessionId: "e2e-decisions", notify: (method, params) => seen.push({ method, params }) },
    );
    await Bun.sleep(50);

    const ready = seen.find((s) => s.method === "decisions.briefReady");
    expect(ready).toBeDefined();
    const params: unknown = ready?.params;
    expect(isBriefReadyParams(params)).toBe(true);
    if (!isBriefReadyParams(params)) return;
    expect(params.brief.length).toBeGreaterThan(0);
    expect(params.findings.kind).toBe("decisions");
  });
});
