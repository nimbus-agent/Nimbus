import type { Database } from "bun:sqlite";
import { annotateDeployment } from "../../../../src/deployment/annotate.ts";

const BASE_TIME = 1_746_000_000_000;
export function seedPaymentServiceFixture(db: Database): { nowMs: number } {
  const t0 = BASE_TIME;
  const t1 = BASE_TIME + 86_400_000;
  const t2 = BASE_TIME + 2 * 86_400_000;
  const nowMs = BASE_TIME + 3 * 86_400_000;

  const annotateTimes = [t0, t1, t2];
  for (let i = 0; i < annotateTimes.length; i++) {
    const t = annotateTimes[i] as number;
    annotateDeployment(
      db,
      {
        service: "payment-service",
        provider: "github-actions",
        environment: "prod",
        sha: `deadbeef${i}`.padEnd(40, "0"),
        ref: "refs/heads/main",
        status: "success",
        started_at_ms: t,
        finished_at_ms: t + 60_000,
        run_id: `run-${i}`,
        job_id: `job-${i}`,
      },
      t,
    );
  }

  for (let i = 0; i < 2; i++) {
    const modifiedAt = BASE_TIME + i * 3_600_000;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                         modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, 'ci_run', ?, 'Deploy ci_run match', '', NULL, NULL, ?, NULL, ?, ?, 0)`,
      [
        `github-actions:ci_run:${i}`,
        "github_actions",
        `acme/payments#run-cirun-${i}`,
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

  return { nowMs };
}
