import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { dbRun } from "../db/write.ts";
import { canonicalizeUrl } from "../util/url-canonical.ts";
import { computeDeploymentExternalId } from "./external-id.ts";
import type {
  DeploymentAnnotateInput,
  DeploymentAnnotateResult,
  DeploymentConclusion,
  DeploymentProvider,
} from "./types.ts";

export class AnnotateError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "AnnotateError";
    this.field = field;
  }
}

const SERVICE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const HTTP_URL_RE = /^https?:\/\//i;
const ONE_HOUR_MS = 3_600_000;
const ONE_YEAR_MS = 365 * 86_400_000;
const SERVICE_MAX = 64;
const ENV_MAX = 32;
const REF_MAX = 256;
const RUN_ID_MAX = 64;
const JOB_ID_MAX = 64;
const URL_MAX = 2048;

const STATUS_VALUES: ReadonlySet<DeploymentConclusion> = new Set([
  "success",
  "failure",
  "cancelled",
  "in_progress",
]);

const PROVIDER_VALUES: ReadonlySet<DeploymentProvider> = new Set([
  "github-actions",
  "gitlab",
  "jenkins",
  "circleci",
  "bitbucket",
  "other",
]);

const DEFAULT_DEPLOY_ENVIRONMENTS: readonly string[] = ["prod"];

function validateServiceAndProvider(input: DeploymentAnnotateInput): void {
  if (
    typeof input.service !== "string" ||
    input.service.length === 0 ||
    input.service.length > SERVICE_MAX
  ) {
    throw new AnnotateError("service", `service must be 1..${SERVICE_MAX} chars`);
  }
  if (!SERVICE_RE.test(input.service)) {
    throw new AnnotateError("service", `service must match ${SERVICE_RE.source}`);
  }
  if (!PROVIDER_VALUES.has(input.provider)) {
    throw new AnnotateError("provider", "provider must be one of the supported values");
  }
}

function validateEnvironment(input: DeploymentAnnotateInput): void {
  if (
    typeof input.environment !== "string" ||
    input.environment.length === 0 ||
    input.environment.length > ENV_MAX
  ) {
    throw new AnnotateError("environment", `environment must be 1..${ENV_MAX} chars`);
  }
  if (!ENV_RE.test(input.environment)) {
    throw new AnnotateError("environment", `environment must match ${ENV_RE.source}`);
  }
}

function validateRefAndStatus(input: DeploymentAnnotateInput): void {
  if (typeof input.ref !== "string" || input.ref.length === 0 || input.ref.length > REF_MAX) {
    throw new AnnotateError("ref", `ref must be 1..${REF_MAX} chars`);
  }
  if (!STATUS_VALUES.has(input.status)) {
    throw new AnnotateError("status", "status must be one of the four supported values");
  }
}

function validateTimestamps(input: DeploymentAnnotateInput, nowMs: number): void {
  if (!Number.isFinite(input.started_at_ms) || !Number.isInteger(input.started_at_ms)) {
    throw new AnnotateError("started_at_ms", "started_at_ms must be an integer (ms since epoch)");
  }
  if (input.started_at_ms < nowMs - ONE_YEAR_MS || input.started_at_ms > nowMs + ONE_HOUR_MS) {
    throw new AnnotateError("started_at_ms", "started_at_ms must be within [now-365d, now+1h]");
  }
  if (input.finished_at_ms === undefined) return;
  if (!Number.isFinite(input.finished_at_ms) || !Number.isInteger(input.finished_at_ms)) {
    throw new AnnotateError("finished_at_ms", "finished_at_ms must be an integer");
  }
  if (input.finished_at_ms < input.started_at_ms) {
    throw new AnnotateError("finished_at_ms", "finished_at_ms must be >= started_at_ms");
  }
  if (input.finished_at_ms > nowMs + ONE_HOUR_MS) {
    throw new AnnotateError("finished_at_ms", "finished_at_ms must not exceed now+1h");
  }
}

function validateOptionalStrings(input: DeploymentAnnotateInput): void {
  if (input.workflow_url !== undefined) {
    if (typeof input.workflow_url !== "string" || input.workflow_url.length > URL_MAX) {
      throw new AnnotateError(
        "workflow_url",
        `workflow_url must be a string up to ${URL_MAX} chars`,
      );
    }
    if (!HTTP_URL_RE.test(input.workflow_url)) {
      throw new AnnotateError("workflow_url", "workflow_url must be http(s)");
    }
  }
  if (input.run_id !== undefined && input.run_id !== "") {
    if (typeof input.run_id !== "string" || input.run_id.length > RUN_ID_MAX) {
      throw new AnnotateError("run_id", `run_id must be 1..${RUN_ID_MAX} chars`);
    }
  }
  if (input.job_id !== undefined && input.job_id !== "") {
    if (typeof input.job_id !== "string" || input.job_id.length > JOB_ID_MAX) {
      throw new AnnotateError("job_id", `job_id must be 1..${JOB_ID_MAX} chars`);
    }
  }
}

function validate(input: DeploymentAnnotateInput, nowMs: number): DeploymentAnnotateInput {
  validateServiceAndProvider(input);
  validateEnvironment(input);
  const lcSha = typeof input.sha === "string" ? input.sha.toLowerCase() : "";
  if (!SHA_RE.test(lcSha)) {
    throw new AnnotateError("sha", "sha must be 7..64 lowercase hex chars");
  }
  validateRefAndStatus(input);
  validateTimestamps(input, nowMs);
  validateOptionalStrings(input);
  return { ...input, sha: lcSha };
}

export interface AnnotateOptions {
  readonly deployEnvironments?: readonly string[];
}

export function annotateDeployment(
  db: Database,
  rawInput: DeploymentAnnotateInput,
  nowMs: number,
  opts: AnnotateOptions = {},
): DeploymentAnnotateResult {
  const input = validate(rawInput, nowMs);
  const externalId = computeDeploymentExternalId(input);
  const itemId = `deployment:${externalId}`;
  const deployEnvs = opts.deployEnvironments ?? DEFAULT_DEPLOY_ENVIRONMENTS;
  const doraEligible = input.status === "success" && deployEnvs.includes(input.environment);

  const isNew = db.transaction(() => {
    const existing = db
      .query("SELECT 1 AS one FROM item WHERE service = ? AND external_id = ? LIMIT 1")
      .get(input.provider, externalId) as { one: number } | null;
    const isNewInner = existing === null;
    const title = `Deploy ${input.service} → ${input.environment} (${input.sha.slice(0, 7)})`;
    const metadata = JSON.stringify({
      nimbus_service_id: input.service,
      environment: input.environment,
      sha: input.sha,
      ref: input.ref,
      conclusion: input.status,
      started_at_ms: input.started_at_ms,
      finished_at_ms: input.finished_at_ms ?? null,
      workflow_url: input.workflow_url ?? null,
      run_id: input.run_id ?? null,
      job_id: input.job_id ?? null,
    });
    // The DERIVED resolve key, mirroring `item-store.ts`'s `upsertIndexedItem` exactly: this is the
    // OTHER production writer of `item` (see the comment there), so it must derive the same value
    // the same way or a deploy annotation's URL silently fails to resolve. `url` and `canonical_url`
    // are both `input.workflow_url` here, so the `canonicalUrl ?? url` preference collapses to one
    // source — kept in this shape anyway so the two derivations read as one rule.
    const resolveSource = input.workflow_url ?? null;
    const resolveKey = resolveSource === null ? null : canonicalizeUrl(resolveSource);
    dbRun(
      db,
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, resolve_key, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, 'deployment', ?, ?, '', ?, ?, ?, ?, NULL, ?, ?, 0)
       ON CONFLICT(service, external_id) DO UPDATE SET
         title = excluded.title,
         url = excluded.url,
         canonical_url = excluded.canonical_url,
         resolve_key = excluded.resolve_key,
         modified_at = excluded.modified_at,
         metadata = excluded.metadata,
         synced_at = excluded.synced_at`,
      [
        itemId,
        input.provider,
        externalId,
        title,
        input.workflow_url ?? null,
        input.workflow_url ?? null,
        resolveKey,
        input.started_at_ms,
        metadata,
        nowMs,
      ],
    );
    dbRun(
      db,
      `INSERT INTO deployment_items
         (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms, conclusion, workflow_url, ci_run_external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         nimbus_service_id = excluded.nimbus_service_id,
         environment = excluded.environment,
         sha = excluded.sha,
         ref = excluded.ref,
         started_at_ms = excluded.started_at_ms,
         finished_at_ms = excluded.finished_at_ms,
         conclusion = excluded.conclusion,
         workflow_url = excluded.workflow_url`,
      [
        itemId,
        input.provider,
        input.service,
        input.environment,
        input.sha,
        input.ref,
        input.started_at_ms,
        input.finished_at_ms ?? null,
        input.status,
        input.workflow_url ?? null,
        null,
        nowMs,
      ],
    );
    appendAuditEntry(db, {
      actionType: "deployment.annotated",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        service: input.service,
        provider: input.provider,
        environment: input.environment,
        sha: input.sha,
        external_id: externalId,
        is_new: isNewInner,
        dora_eligible: doraEligible,
      }),
      timestamp: nowMs,
    });
    return isNewInner;
  })();

  return {
    external_id: externalId,
    service: input.service,
    stored_at_ms: nowMs,
    is_new: isNew,
    dora_eligible: doraEligible,
  };
}
