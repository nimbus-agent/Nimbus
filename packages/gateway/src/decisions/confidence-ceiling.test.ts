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
 * F25 — the expiry check a standing disclosure never had.
 *
 * `nimbus decisions` USED TO ship an unconditional gap note explaining that confidence topped out
 * at 0.86 because "no connector indexes changed-file paths". Invariant I31 protected that sentence
 * perfectly: the `## Gaps` section is constructed by the renderer, withheld from the model,
 * re-attached verbatim, and anchor-checked. Every one of those mechanisms operated correctly on a
 * statement whose premise had become FALSE — V55 shipped `pr_changed_file` — and each one made it
 * MORE durable. It could not be paraphrased away, could not be dropped by a rewrite, and read with
 * the authority of a machine-generated disclosure.
 *
 * I31 guarantees a disclosure SURVIVES. Nothing guaranteed it was still TRUE. A disclosure is
 * load-bearing precisely because a user cannot check it, so its correctness has to be maintained
 * like a wiring site — which is what this repo's invariant triple rule already says about every
 * other defense in it.
 *
 * The note is now gone: the real cause was two dead branches in `corroboration()` scoring against
 * evidence nothing emits, and those were removed rather than re-explained. What remains here is
 * the check that was missing — these fail if either half of the old premise changes, so a future
 * wiring of `migration`/`iac` has to revisit the scale deliberately instead of silently.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const DECISIONS_DIR = join(import.meta.dir);

describe("the ceiling is derived, not written down", () => {
  test("full marks are reachable from evidence the pass actually emits", () => {
    // The point of the rescale. Before it this was 0.86, and no real decision could score full
    // marks on a 0..1 scale — which is what the standing gap note existed to apologise for.
    expect(maxReachableConfidence()).toBeCloseTo(1, 5);
  });

  test("the derived value is what the best emitted evidence actually scores", () => {
    // Derived, never a literal. A prose figure beside the arithmetic that produces it is two
    // copies of one fact, and `brief-disclosures.ts` exists because two copies of a disclosure
    // drifted; F25 was that same failure one level up.
    const best = computeConfidence({
      tier: "heading",
      evidenceKinds: EMITTED_EVIDENCE_KINDS,
      serviceType: "notion:page",
      hasRationale: true,
      hasAlternatives: true,
    });
    expect(best).toBeCloseTo(maxReachableConfidence(), 10);
  });

  test("the unemitted kinds no longer move the score", () => {
    // They were removed rather than re-explained. If a future change makes them reachable, this
    // fails and whoever does it has to decide what the scale means again — deliberately.
    const withArtifact = computeConfidence({
      tier: "heading",
      evidenceKinds: [...EMITTED_EVIDENCE_KINDS, "migration"],
      serviceType: "notion:page",
      hasRationale: true,
      hasAlternatives: true,
    });
    expect(withArtifact).toBeCloseTo(maxReachableConfidence(), 10);
  });
});

describe("the disclosure's premise, checked against the world", () => {
  test("no writer in the decisions pass emits migration or iac evidence", () => {
    // This is what makes removing the two branches from `corroboration()` correct rather than a
    // silent loss of signal: nothing produces the evidence they scored. Scanned rather than read
    // off the type union, because the union DECLARES both kinds — it is the WRITERS that do not.
    const src = readFileSync(join(DECISIONS_DIR, "decision-corroborate.ts"), "utf8");
    const emitted = [...src.matchAll(/kind:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(emitted).not.toContain("migration");
    expect(emitted).not.toContain("iac");
  });

  test("the changed-file substrate DOES exist, so the old wording was stale", () => {
    // The original sentence said "no connector indexes changed-file paths". `pr_changed_file`
    // and `pr_files_state` shipped at V55 and were 100% covered on the machine where the brief
    // was read — the same gateway printed "PR file coverage: 173 / 173" in the same session.
    // The ceiling was real; its stated CAUSE was not. Kept as a regression test on the claim
    // itself, since it is the substrate a future wiring would read.
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
    // When this fails the wiring landed, `migration`/`iac` become emittable, and whoever did it
    // must decide what the corroboration term should weigh — the decision F25 forced once and
    // that this keeps from being made by accident.
    const src = readFileSync(join(DECISIONS_DIR, "decision-corroborate.ts"), "utf8");
    expect(src).not.toContain("pr_changed_file");
  });
});
