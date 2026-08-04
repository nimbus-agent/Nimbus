import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentFrequency } from "../../../src/metrics/dora.ts";
import type { ServiceConfig } from "../../../src/metrics/dora-config.ts";
import { seedPaymentServiceFixture } from "../../fixtures/deployments/payment-service/seed.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

function cfg(): ServiceConfig {
  return {
    serviceId: "payment-service",
    repos: [{ provider: "github", providerId: "acme/payments" }],
    pagerdutyServices: [],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
}

describe("dora.deploymentFrequency — source preference", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-source-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), 28);
  });

  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* Windows EBUSY — OS cleans temp dir on reboot */
    }
  });

  test("annotated deploys win; regex ci_run rows are ignored even when present (mixed_source gap)", () => {
    const { nowMs } = seedPaymentServiceFixture(db);
    const window = 30 * 86_400_000;
    const df = deploymentFrequency(db, cfg(), nowMs, window);
    expect(df.sample).toBe(3);
    expect(df.gap).toBe("mixed_source");
    expect(df.value).not.toBeNull();
    expect(df.value).toBeCloseTo(3 / 30, 5);
  });

  test("regex-only window: gap is null (legacy path)", () => {
    const t = 1_746_000_000_000;
    for (let i = 0; i < 5; i++) {
      const modifiedAt = t + i * 3_600_000;
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                           modified_at, author_id, metadata, synced_at, pinned)
         VALUES (?, ?, 'ci_run', ?, 'Deploy regex', '', NULL, NULL, ?, NULL, ?, ?, 0)`,
        [
          `github-actions:ci_run:legacy-${i}`,
          "github_actions",
          `acme/payments#run-legacy-${i}`,
          modifiedAt,
          JSON.stringify({
            repo: "acme/payments",
            workflowName: "Deploy",
            conclusion: "success",
            headBranch: "main",
          }),
          modifiedAt,
        ],
      );
    }
    const df = deploymentFrequency(db, cfg(), t + 6 * 3_600_000, 30 * 86_400_000);
    expect(df.sample).toBe(5);
    expect(df.gap).toBeNull();
    expect(df.value).not.toBeNull();
  });

  test("no deploys at all: no_deployment_data", () => {
    const df = deploymentFrequency(db, cfg(), 1_746_000_000_000, 30 * 86_400_000);
    expect(df.sample).toBe(0);
    expect(df.gap).toBe("no_deployment_data");
    expect(df.value).toBeNull();
  });
});
