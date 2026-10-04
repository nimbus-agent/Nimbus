/**
 * The input-validation refusals of `annotateDeployment` that `annotate.test.ts` leaves unexercised,
 * plus the boundaries each bound is drawn at. Every refusal is checked to happen BEFORE anything is
 * written: no `item`, no `deployment_items` row and no `deployment.annotated` audit row.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  AnnotateError,
  annotateDeployment,
  validateDeploymentSha,
} from "../../../src/deployment/annotate.ts";
import type { DeploymentAnnotateInput } from "../../../src/deployment/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

const NOW = 1_747_142_641_204;
const HOUR = 3_600_000;
const YEAR = 365 * 86_400_000;

const valid: DeploymentAnnotateInput = {
  service: "payment-service",
  provider: "github-actions",
  environment: "prod",
  sha: "a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4",
  ref: "refs/heads/main",
  status: "success",
  started_at_ms: NOW - 1000,
  finished_at_ms: NOW - 500,
  workflow_url: "https://github.com/acme/payments/actions/runs/12345",
  run_id: "12345",
  job_id: "67890",
};

function openDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

type Written = { items: number; deployments: number; audits: number };

function written(db: Database): Written {
  const count = (sql: string): number => (db.query(sql).get() as { n: number }).n;
  return {
    items: count("SELECT COUNT(*) AS n FROM item"),
    deployments: count("SELECT COUNT(*) AS n FROM deployment_items"),
    audits: count("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'deployment.annotated'"),
  };
}

const NOTHING: Written = { items: 0, deployments: 0, audits: 0 };

/** Runs one annotation that must be refused; returns the refusal and what reached the database. */
function refuse(
  patch: Record<string, unknown>,
  nowMs = NOW,
): { field: string; message: string; written: Written } {
  const db = openDb();
  try {
    annotateDeployment(db, { ...valid, ...patch } as DeploymentAnnotateInput, nowMs);
  } catch (e) {
    if (!(e instanceof AnnotateError)) throw e;
    const after = written(db);
    db.close();
    return { field: e.field, message: e.message, written: after };
  }
  db.close();
  throw new Error(`expected a refusal for ${JSON.stringify(patch)}`);
}

/** Runs one annotation that must be accepted; returns what reached the database. */
function accept(patch: Record<string, unknown>, nowMs = NOW): Written {
  const db = openDb();
  annotateDeployment(db, { ...valid, ...patch } as DeploymentAnnotateInput, nowMs);
  const after = written(db);
  db.close();
  return after;
}

const ONE_OF_EACH: Written = { items: 1, deployments: 1, audits: 1 };

type RefusalCase = {
  label: string;
  patch: Record<string, unknown>;
  field: string;
  message: string;
};

const REFUSALS: RefusalCase[] = [
  {
    label: "an empty service",
    patch: { service: "" },
    field: "service",
    message: "service must be 1..64 chars",
  },
  {
    label: "a 65-char service",
    patch: { service: "s".repeat(65) },
    field: "service",
    message: "service must be 1..64 chars",
  },
  {
    label: "a non-string service",
    patch: { service: 3 },
    field: "service",
    message: "service must be 1..64 chars",
  },
  {
    label: "an unknown provider",
    patch: { provider: "travis" },
    field: "provider",
    message: "provider must be one of the supported values",
  },
  {
    label: "an empty environment",
    patch: { environment: "" },
    field: "environment",
    message: "environment must be 1..32 chars",
  },
  {
    label: "a 33-char environment",
    patch: { environment: "e".repeat(33) },
    field: "environment",
    message: "environment must be 1..32 chars",
  },
  {
    label: "a non-string environment",
    patch: { environment: 7 },
    field: "environment",
    message: "environment must be 1..32 chars",
  },
  {
    label: "an environment outside the slug alphabet",
    patch: { environment: "Prod" },
    field: "environment",
    message: "environment must match ^[a-z0-9][a-z0-9._-]*$",
  },
  {
    label: "a non-string sha",
    patch: { sha: 0xabcdef1 },
    field: "sha",
    message: "sha must be 7..64 lowercase hex chars",
  },
  {
    label: "an empty ref",
    patch: { ref: "" },
    field: "ref",
    message: "ref must be 1..256 chars",
  },
  {
    label: "a 257-char ref",
    patch: { ref: "r".repeat(257) },
    field: "ref",
    message: "ref must be 1..256 chars",
  },
  {
    label: "a non-string ref",
    patch: { ref: 42 },
    field: "ref",
    message: "ref must be 1..256 chars",
  },
  {
    label: "an unknown status",
    patch: { status: "skipped" },
    field: "status",
    message: "status must be one of the four supported values",
  },
  {
    label: "a fractional started_at_ms",
    patch: { started_at_ms: NOW - 1000.5 },
    field: "started_at_ms",
    message: "started_at_ms must be an integer (ms since epoch)",
  },
  {
    label: "a NaN started_at_ms",
    patch: { started_at_ms: Number.NaN },
    field: "started_at_ms",
    message: "started_at_ms must be an integer (ms since epoch)",
  },
  {
    label: "a started_at_ms more than an hour ahead",
    patch: { started_at_ms: NOW + HOUR + 1, finished_at_ms: undefined },
    field: "started_at_ms",
    message: "started_at_ms must be within [now-365d, now+1h]",
  },
  {
    label: "a fractional finished_at_ms",
    patch: { finished_at_ms: NOW - 499.5 },
    field: "finished_at_ms",
    message: "finished_at_ms must be an integer",
  },
  {
    label: "an infinite finished_at_ms",
    patch: { finished_at_ms: Number.POSITIVE_INFINITY },
    field: "finished_at_ms",
    message: "finished_at_ms must be an integer",
  },
  {
    label: "a finished_at_ms more than an hour ahead",
    patch: { started_at_ms: NOW, finished_at_ms: NOW + HOUR + 1 },
    field: "finished_at_ms",
    message: "finished_at_ms must not exceed now+1h",
  },
  {
    label: "a non-string workflow_url",
    patch: { workflow_url: 12345 },
    field: "workflow_url",
    message: "workflow_url must be a string up to 2048 chars",
  },
  {
    label: "a 2049-char workflow_url",
    patch: {
      workflow_url: `https://ci.example/${"a".repeat(2049 - "https://ci.example/".length)}`,
    },
    field: "workflow_url",
    message: "workflow_url must be a string up to 2048 chars",
  },
  {
    label: "a non-http(s) workflow_url",
    patch: { workflow_url: "ftp://ci.example/runs/1" },
    field: "workflow_url",
    message: "workflow_url must be http(s)",
  },
  {
    label: "a 65-char run_id",
    patch: { run_id: "1".repeat(65) },
    field: "run_id",
    message: "run_id must be 1..64 chars",
  },
  {
    label: "a non-string run_id",
    patch: { run_id: 12345 },
    field: "run_id",
    message: "run_id must be 1..64 chars",
  },
  {
    label: "a 65-char job_id",
    patch: { job_id: "2".repeat(65) },
    field: "job_id",
    message: "job_id must be 1..64 chars",
  },
  {
    label: "a non-string job_id",
    patch: { job_id: 67890 },
    field: "job_id",
    message: "job_id must be 1..64 chars",
  },
];

describe("annotateDeployment — refusals happen before any write", () => {
  test.each(REFUSALS)("$label is refused on $field", ({ patch, field, message }: RefusalCase) => {
    const r = refuse(patch);
    expect({ field: r.field, message: r.message }).toEqual({ field, message });
    expect(r.written).toEqual(NOTHING);
  });

  test("each bound accepts the value exactly at its limit", () => {
    // workflow_url at exactly URL_MAX, run_id/job_id at exactly 64, a finish exactly an hour
    // ahead, a start exactly an hour ahead AND exactly 365 days back, a finish equal to its start,
    // an environment of exactly 32 chars and a ref of exactly 256 — every one is stored.
    const url = `https://ci.example/${"a".repeat(2048 - "https://ci.example/".length)}`;
    expect(url).toHaveLength(2048);
    expect(accept({ workflow_url: url })).toEqual(ONE_OF_EACH);
    expect(accept({ run_id: "1".repeat(64), job_id: "2".repeat(64) })).toEqual(ONE_OF_EACH);
    expect(accept({ started_at_ms: NOW, finished_at_ms: NOW + HOUR })).toEqual(ONE_OF_EACH);
    expect(accept({ started_at_ms: NOW + HOUR, finished_at_ms: undefined })).toEqual(ONE_OF_EACH);
    expect(accept({ started_at_ms: NOW - YEAR, finished_at_ms: undefined })).toEqual(ONE_OF_EACH);
    expect(accept({ started_at_ms: NOW - 1000, finished_at_ms: NOW - 1000 })).toEqual(ONE_OF_EACH);
    expect(accept({ environment: "e".repeat(32) })).toEqual(ONE_OF_EACH);
    expect(accept({ ref: "r".repeat(256) })).toEqual(ONE_OF_EACH);
    expect(accept({ service: "s".repeat(64) })).toEqual(ONE_OF_EACH);
  });

  test("a start one millisecond older than 365 days, or a finish one before its start, is refused", () => {
    // The two refusals that frame the accepted bounds above, so neither bound can drift a
    // millisecond in either direction without a test going red.
    expect(refuse({ started_at_ms: NOW - YEAR - 1, finished_at_ms: undefined })).toEqual({
      field: "started_at_ms",
      message: "started_at_ms must be within [now-365d, now+1h]",
      written: NOTHING,
    });
    expect(refuse({ started_at_ms: NOW - 1000, finished_at_ms: NOW - 1001 })).toEqual({
      field: "finished_at_ms",
      message: "finished_at_ms must be >= started_at_ms",
      written: NOTHING,
    });
  });

  test("an upper-case HTTPS scheme is still http(s)", () => {
    expect(accept({ workflow_url: "HTTPS://CI.EXAMPLE/runs/1" })).toEqual(ONE_OF_EACH);
  });

  test("an omitted workflow_url, run_id and job_id store null in the metadata", () => {
    const db = openDb();
    const { workflow_url: _url, run_id: _run, job_id: _job, ...withoutOptionals } = valid;
    const r = annotateDeployment(db, withoutOptionals, NOW);
    const row = db
      .query("SELECT url, canonical_url, resolve_key, metadata FROM item WHERE external_id = ?")
      .get(r.external_id) as {
      url: string | null;
      canonical_url: string | null;
      resolve_key: string | null;
      metadata: string;
    };
    db.close();
    expect(row.url).toBeNull();
    expect(row.canonical_url).toBeNull();
    expect(row.resolve_key).toBeNull();
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta["workflow_url"]).toBeNull();
    expect(meta["run_id"]).toBeNull();
    expect(meta["job_id"]).toBeNull();
    expect(meta["finished_at_ms"]).toBe(NOW - 500);
  });
});

describe("validateDeploymentSha", () => {
  test("lower-cases a valid sha and refuses every non-string", () => {
    expect(validateDeploymentSha("ABCDEF0")).toBe("abcdef0");
    for (const bad of [undefined, null, 1234567, ["abcdef0"]]) {
      let caught: unknown;
      try {
        validateDeploymentSha(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AnnotateError);
      expect((caught as AnnotateError).field).toBe("sha");
    }
  });
});
