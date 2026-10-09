import { describe, expect, test } from "bun:test";
import { CI_RUN_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/ci-run-meta.ts";
import { PR_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/pr-meta.ts";
import { collectLaneCensus } from "../check-index-lane-coverage.ts";
import { contractEmissions } from "./contract-emissions.ts";

describe("contractEmissions", () => {
  test("one row per (service, type), keys exactly the table's", () => {
    const rows = contractEmissions();
    for (const [service, keys] of Object.entries(CI_RUN_EMITTED_KEYS)) {
      const row = rows.find((r) => r.service === service && r.itemType === "ci_run");
      expect(row?.metadataKeys).toEqual([...keys].sort());
    }
    for (const [service, keys] of Object.entries(PR_EMITTED_KEYS)) {
      const row = rows.find((r) => r.service === service && r.itemType === "pr");
      expect(row?.metadataKeys).toEqual([...keys].sort());
    }
  });

  test("a contract key one provider omits is a precise partial naming the emitters", () => {
    const census = collectLaneCensus(
      [
        {
          relPath: "packages/gateway/src/p.ts",
          contents:
            "db.query(`SELECT 1 FROM item WHERE type = 'ci_run' AND json_extract(metadata, '$.branch') = ?`);",
        },
      ],
      { contractEmissions: contractEmissions() },
    );
    const hit = census.unmatchedItemReads.find((r) => r.value === "branch");
    expect(hit?.matchState).toBe("partial");
    expect(hit?.partialCoverage).toEqual(["circleci", "github_actions", "gitlab"]);
  });
});
