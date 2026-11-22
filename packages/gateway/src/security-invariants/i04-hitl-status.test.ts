import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO_ROOT, read } from "../../test/helpers/security-invariants.ts";

describe("I4 — hitlStatus is consent-output-only in production paths", () => {
  /**
   * Files permitted to write `hitlStatus: "approved"` inline, each because the row RECORDS a
   * consent decision that a gate has already made on that exact path. Every entry was checked
   * against its gate, not assumed — an allowlist whose members were never verified is how a guard
   * becomes a laundering mechanism for the thing it polices.
   *
   * This is deliberately NOT the list of files that currently contain the string. `reindex.ts`
   * was on that list and is not here: its row sat on a path where the gate is structurally never
   * entered, so it was recording an approval that never happened. It now writes `not_required`.
   */
  const APPROVED_ROW_IS_EARNED: ReadonlyMap<string, string> = new Map([
    ["packages/gateway/src/egress/egress-prune.ts", "egress.prune ∈ HITL_REQUIRED (I2 frozen set)"],
    [
      "packages/gateway/src/extensions/install-from-local.ts",
      "extension.install_complete records the executor-gated extension.install approval (approve hook)",
    ],
    [
      "packages/gateway/src/ipc/federation-rpc.ts",
      "federation.purge records the consent-broker HITL decision in the same handler",
    ],
    ["packages/gateway/src/share/share-gate.ts", "share.publish ∈ HITL_REQUIRED (I27 origin)"],
    [
      "packages/gateway/src/share/share-forward.ts",
      "share.publish ∈ HITL_REQUIRED (I27 re-forward)",
    ],
  ]);

  test('no production file outside the earned set hardcodes hitlStatus: "approved"', async () => {
    // The entire enforcement of I4 used to be one `read()` of `commands/data-delete.ts` and one
    // `not.toMatch`. Adding the string to ANY other file was invisible to CI — and one had:
    // `connectors/reindex.ts` forged an `approved` row on the ungated metadata_only path. There is
    // no static D-rule for I4 either, so that single grep was the whole of it.
    const offenders: string[] = [];
    for (const pkg of ["gateway", "cli", "ui"]) {
      const root = resolve(REPO_ROOT, "packages", pkg, "src");
      for (const f of await readdir(root, { recursive: true })) {
        const rel = `packages/${pkg}/src/${f.replaceAll("\\", "/")}`;
        // `.tsx` too. A `.ts`-only filter skipped 60 production files — 53 under `packages/ui/src`
        // and 7 under `packages/cli/src` — which is where an IPC-shaped audit row is most likely
        // to be hand-built in the first place.
        const isProdSource =
          (rel.endsWith(".ts") || rel.endsWith(".tsx")) &&
          !rel.endsWith(".test.ts") &&
          !rel.endsWith(".test.tsx") &&
          !rel.endsWith(".d.ts");
        if (!isProdSource) continue;
        if (APPROVED_ROW_IS_EARNED.has(rel)) continue;
        const src = await readFile(resolve(REPO_ROOT, rel), "utf8");
        // The union TYPE (`hitlStatus: "approved" | "rejected" | "not_required"`) is a declaration,
        // not an assignment, and appears in executor.ts / types.ts / local-index.ts by design.
        if (/hitlStatus:\s*"approved"(?!\s*\|)/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every earned entry still contains the row it is exempted for", async () => {
    // The other direction. An exemption for a file that no longer writes the row is dead weight
    // that quietly re-permits the string if the file is later reused for something else — the
    // same way a stale allowlist entry outlives the reason it was added.
    const stale: string[] = [];
    for (const [rel] of APPROVED_ROW_IS_EARNED) {
      const src = await readFile(resolve(REPO_ROOT, rel), "utf8");
      if (!/hitlStatus:\s*"approved"/.test(src)) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});

describe("I4 — the fourth status is reserved (Phase 10 SA1)", () => {
  test("the gate, the audit sink and the ledger name exactly four statuses", async () => {
    const four = /"approved"\s*\|\s*"rejected"\s*\|\s*"not_required"\s*\|\s*"standing_approved"/;
    expect(await read("packages/gateway/src/engine/executor.ts")).toMatch(
      new RegExp(`type HitlStatus = ${four.source}`),
    );
    expect(await read("packages/gateway/src/engine/types.ts")).toMatch(four);
    expect(await read("packages/gateway/src/egress/egress-record.ts")).toMatch(
      /"approved"\s*\|\s*"not_required"\s*\|\s*"rejected"\s*\|\s*"standing_approved"/,
    );
  });

  test("only the migration DDL (V87) and the status maps mention standing_approved as a value", async () => {
    // I55 (SA3): the executor's `standingApproval`, from `standingRuleStep`'s match, is the ONLY
    // production path that CONSTRUCTS the outcome or writes the row. The same pin lives in
    // `engine/approval-outcome.test.ts` for the outcome kind.
    const offenders: string[] = [];
    const root = resolve(REPO_ROOT, "packages", "gateway", "src");
    for (const f of await readdir(root, { recursive: true })) {
      const rel = f.replaceAll("\\", "/");
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      const src = await readFile(resolve(root, f), "utf8");
      if (/(?:kind|hitlStatus):\s*"standing_approved"\s*[,}]/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual(["engine/executor.ts"]);
  });
});
