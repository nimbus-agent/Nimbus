import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LocalIndex } from "../index/local-index.ts";
import {
  computeConfidence,
  EMITTED_EVIDENCE_KINDS,
  maxReachableConfidence,
} from "./decision-confidence.ts";

/**
 * F25 — the expiry check for a standing disclosure.
 *
 * `nimbus decisions` ships an unconditional gap note explaining that confidence tops out at 0.86.
 * Invariant I31 protects that sentence perfectly: the `## Gaps` section is constructed by the
 * renderer, withheld from the model, re-attached verbatim, and anchor-checked. Every one of those
 * mechanisms operated correctly on a statement whose premise had become FALSE — and each one made
 * it more durable. It could not be paraphrased away, could not be dropped by a rewrite, and read
 * with the authority of a machine-generated disclosure.
 *
 * I31 guarantees a disclosure SURVIVES. Nothing guaranteed it was still TRUE. A disclosure is
 * load-bearing precisely because a user cannot check it, so its correctness has to be maintained
 * like a wiring site — which is what this repo's invariant triple rule already says about every
 * other defense in it.
 *
 * These tests fail when the premise changes, so the sentence has to change with it.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const DECISIONS_DIR = join(import.meta.dir);

describe("the ceiling is derived, not written down", () => {
  test("maxReachableConfidence agrees with the figure the brief quotes", () => {
    expect(maxReachableConfidence()).toBeCloseTo(0.86, 2);
  });

  test("it is genuinely a ceiling — nothing emitted scores higher", () => {
    const best = computeConfidence({
      tier: "heading",
      evidenceKinds: EMITTED_EVIDENCE_KINDS,
      serviceType: "notion:page",
      hasRationale: true,
      hasAlternatives: true,
    });
    expect(best).toBeLessThan(1);
    expect(best).toBeCloseTo(maxReachableConfidence(), 10);
  });

  test("adding the unemitted kinds WOULD reach 1.0, which is why the gap exists", () => {
    // Pins the cause. If this stops being true the explanation is wrong even if the number is
    // still 0.86, and a reader would be told the wrong thing about why.
    const withArtifact = computeConfidence({
      tier: "heading",
      evidenceKinds: [...EMITTED_EVIDENCE_KINDS, "migration"],
      serviceType: "notion:page",
      hasRationale: true,
      hasAlternatives: true,
    });
    expect(withArtifact).toBeCloseTo(1, 10);
  });
});

describe("the disclosure's premise, checked against the world", () => {
  test("no writer in the decisions pass emits migration or iac evidence", () => {
    // The moment one does, the ceiling stops being 0.86 and the gap note becomes false in the
    // other direction. Scanned rather than asserted from the type union, because the union
    // DECLARES both kinds — it is the writers that do not produce them.
    const src = readFileSync(join(DECISIONS_DIR, "decision-corroborate.ts"), "utf8");
    const emitted = [...src.matchAll(/kind:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(emitted).not.toContain("migration");
    expect(emitted).not.toContain("iac");
  });

  test("the changed-file substrate DOES exist, so the old wording was stale", () => {
    // The original sentence said "no connector indexes changed-file paths". `pr_changed_file`
    // and `pr_files_state` shipped at V55 and were 100% covered on the machine where the brief
    // was read — the same gateway printed "PR file coverage: 173 / 173" in the same session.
    // The ceiling was real; its stated CAUSE was not.
    const db = new Database(":memory:");
    openDbs.push(db);
    LocalIndex.ensureSchema(db);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("pr_changed_file");
    expect(names).toContain("pr_files_state");
  });

  test("the decisions pass is still not wired to that substrate", () => {
    // The other half of the corrected premise. When this fails, the wiring landed and the gap
    // note must be removed rather than reworded.
    const src = readFileSync(join(DECISIONS_DIR, "decision-corroborate.ts"), "utf8");
    expect(src).not.toContain("pr_changed_file");
  });
});
