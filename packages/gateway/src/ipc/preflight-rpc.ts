import type { Database } from "bun:sqlite";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { computeDeployPreflight, type DeployPreflightResult } from "../preflight/preflight.ts";

export class PreflightRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "PreflightRpcError";
    this.rpcCode = rpcCode;
  }
}

export type PreflightRpcContext = {
  db: Database;
  loadConfig: () => Map<string, ServiceConfig>;
  nowMs?: () => number;
};

const MIN_SERVICE_LEN = 1;
const MAX_SERVICE_LEN = 64;
const MIN_TARGET_REF_LEN = 1;
const MAX_TARGET_REF_LEN = 255;
const DEFAULT_MAX_FINDINGS = 10;
const MIN_MAX_FINDINGS = 1;
const MAX_MAX_FINDINGS = 50;

function requireParams(params: unknown): {
  service: string;
  targetRef: string;
  maxFindings: number;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new PreflightRpcError(
      -32602,
      "deploy.preflight requires { service: string, target_ref: string }",
    );
  }
  const p = params as {
    service?: unknown;
    target_ref?: unknown;
    max_findings?: unknown;
  };

  if (typeof p.service !== "string") {
    throw new PreflightRpcError(-32602, "service must be a string");
  }
  const service = p.service.trim();
  if (service.length < MIN_SERVICE_LEN || service.length > MAX_SERVICE_LEN) {
    throw new PreflightRpcError(
      -32602,
      `service must be ${MIN_SERVICE_LEN}..${MAX_SERVICE_LEN} chars`,
    );
  }

  if (typeof p.target_ref !== "string") {
    throw new PreflightRpcError(-32602, "target_ref must be a string");
  }
  const targetRef = p.target_ref.trim();
  if (targetRef.length < MIN_TARGET_REF_LEN || targetRef.length > MAX_TARGET_REF_LEN) {
    throw new PreflightRpcError(
      -32602,
      `target_ref must be ${MIN_TARGET_REF_LEN}..${MAX_TARGET_REF_LEN} chars`,
    );
  }

  const maxFindings = p.max_findings === undefined ? DEFAULT_MAX_FINDINGS : p.max_findings;
  if (
    typeof maxFindings !== "number" ||
    !Number.isInteger(maxFindings) ||
    maxFindings < MIN_MAX_FINDINGS ||
    maxFindings > MAX_MAX_FINDINGS
  ) {
    throw new PreflightRpcError(
      -32602,
      `max_findings must be an integer ${MIN_MAX_FINDINGS}..${MAX_MAX_FINDINGS}`,
    );
  }

  return { service, targetRef, maxFindings };
}

/**
 * The service id is in neither `[metrics.dora.<id>]` nor `[ci.service.<id>]`, so not one of the
 * three checks could run.
 *
 * Verdict is `warn`, NOT `ok` (F24a). `--mode block` is a deploy gate and its only mechanism is
 * the exit code: `commands/deploy.ts` exits 1 when `mode === "block" && verdict === "warn"`, and
 * the first-party Action's `decideExitCode` does the same. Returning `ok` here made a typo'd or
 * renamed service id pass the gate silently — a healthy service and a nonexistent one produced
 * byte-identical envelopes apart from their gap labels.
 *
 * `warn` rather than a new third verdict, deliberately: the published Action's `safeVerdict`
 * coerces every value it does not recognise, so a `"unknown_service"` VERDICT would arrive at an
 * already-deployed Action as `ok` and reintroduce the same fail-open one layer out. `warn` is the
 * only value that fails closed in every consumer, old and new. The reason travels in the gap
 * instead, which is a free-form string on the wire and degrades to a printed label.
 *
 * Counts stay 0 with no findings: this is "could not evaluate", not "found three problems", and
 * the gap is what distinguishes them.
 */
function unconfiguredEnvelope(
  service: string,
  targetRef: string,
  nowMs: number,
): DeployPreflightResult {
  return {
    service,
    target_ref: targetRef,
    computed_at: new Date(nowMs).toISOString(),
    verdict: "warn",
    checks: {
      active_p1_incidents: { count: 0, findings: [], gap: "unknown_service" },
      failing_ci_runs: { count: 0, findings: [], gap: "unknown_service" },
      merge_conflicts: { count: 0, findings: [], gap: "unknown_service" },
    },
  };
}

export async function dispatchPreflightRpc(
  method: string,
  params: unknown,
  ctx: PreflightRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: DeployPreflightResult }> {
  if (method !== "deploy.preflight") return { kind: "miss" };
  const { service, targetRef, maxFindings } = requireParams(params);
  const nowMs = (ctx.nowMs ?? (() => Date.now()))();
  const configMap = ctx.loadConfig();
  const cfg = configMap.get(service);
  if (cfg === undefined) {
    return { kind: "hit", value: unconfiguredEnvelope(service, targetRef, nowMs) };
  }
  return {
    kind: "hit",
    value: computeDeployPreflight(ctx.db, cfg, targetRef, nowMs, maxFindings),
  };
}
