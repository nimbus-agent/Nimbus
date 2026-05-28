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

function unconfiguredEnvelope(
  service: string,
  targetRef: string,
  nowMs: number,
): DeployPreflightResult {
  return {
    service,
    target_ref: targetRef,
    computed_at: new Date(nowMs).toISOString(),
    verdict: "ok",
    checks: {
      active_p1_incidents: {
        count: 0,
        findings: [],
        gap: "no_pagerduty_mapping",
      },
      failing_ci_runs: { count: 0, findings: [], gap: "no_repos" },
      merge_conflicts: { count: 0, findings: [], gap: "no_repos" },
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
