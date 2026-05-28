import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type DeployAnnotateStatus = "success" | "failure" | "cancelled" | "in_progress";

export type DeployAnnotateProvider =
  | "github-actions"
  | "gitlab"
  | "jenkins"
  | "circleci"
  | "bitbucket"
  | "other";

export interface DeployAnnotateArgs {
  readonly service: string;
  readonly sha: string;
  readonly targetRef: string;
  readonly env: string;
  readonly status: DeployAnnotateStatus;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | undefined;
  readonly workflowUrl: string | undefined;
  readonly provider: DeployAnnotateProvider;
  readonly runId: string | undefined;
  readonly jobId: string | undefined;
  readonly json: boolean;
}

export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgParseError";
  }
}

const SERVICE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const SERVICE_MAX = 64;
const ENV_MAX = 32;

const STATUS_VALUES: ReadonlySet<DeployAnnotateStatus> = new Set([
  "success",
  "failure",
  "cancelled",
  "in_progress",
]);

const PROVIDER_VALUES: ReadonlySet<DeployAnnotateProvider> = new Set([
  "github-actions",
  "gitlab",
  "jenkins",
  "circleci",
  "bitbucket",
  "other",
]);

function requireValue(name: string, value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArgParseError(`${name} requires a non-empty value`);
  }
  return value;
}

function parseIntegerMs(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new ArgParseError(`${name} must be an integer (ms since epoch)`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ArgParseError(`${name} must be an integer (ms since epoch)`);
  }
  return n;
}

export function parseDeployAnnotateArgs(argv: readonly string[]): DeployAnnotateArgs {
  let service: string | undefined;
  let sha: string | undefined;
  let targetRef: string | undefined;
  let env: string | undefined;
  let status: DeployAnnotateStatus | undefined;
  let startedAtMs: number | undefined;
  let finishedAtMs: number | undefined;
  let workflowUrl: string | undefined;
  let provider: DeployAnnotateProvider = "other";
  let runId: string | undefined;
  let jobId: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--service": {
        service = requireValue("--service", argv[i + 1]).trim();
        i += 1;
        break;
      }
      case "--sha": {
        sha = requireValue("--sha", argv[i + 1])
          .trim()
          .toLowerCase();
        i += 1;
        break;
      }
      case "--target-ref": {
        targetRef = requireValue("--target-ref", argv[i + 1]).trim();
        i += 1;
        break;
      }
      case "--env": {
        env = requireValue("--env", argv[i + 1]).trim();
        i += 1;
        break;
      }
      case "--status": {
        const v = requireValue("--status", argv[i + 1]).trim();
        if (!STATUS_VALUES.has(v as DeployAnnotateStatus)) {
          throw new ArgParseError(
            "--status must be one of: success, failure, cancelled, in_progress",
          );
        }
        status = v as DeployAnnotateStatus;
        i += 1;
        break;
      }
      case "--started-at": {
        startedAtMs = parseIntegerMs("--started-at", requireValue("--started-at", argv[i + 1]));
        i += 1;
        break;
      }
      case "--finished-at": {
        finishedAtMs = parseIntegerMs("--finished-at", requireValue("--finished-at", argv[i + 1]));
        i += 1;
        break;
      }
      case "--workflow-url": {
        workflowUrl = requireValue("--workflow-url", argv[i + 1]).trim();
        i += 1;
        break;
      }
      case "--provider": {
        const v = requireValue("--provider", argv[i + 1]).trim();
        if (!PROVIDER_VALUES.has(v as DeployAnnotateProvider)) {
          throw new ArgParseError(
            "--provider must be one of: github-actions, gitlab, jenkins, circleci, bitbucket, other",
          );
        }
        provider = v as DeployAnnotateProvider;
        i += 1;
        break;
      }
      case "--run-id": {
        runId = requireValue("--run-id", argv[i + 1]).trim();
        i += 1;
        break;
      }
      case "--job-id": {
        jobId = requireValue("--job-id", argv[i + 1]).trim();
        i += 1;
        break;
      }
      case "--json": {
        json = true;
        break;
      }
      default: {
        if (typeof a === "string" && a.startsWith("--")) {
          throw new ArgParseError(`unknown flag: ${a}`);
        }
        break;
      }
    }
  }

  if (service === undefined) {
    throw new ArgParseError("--service is required");
  }
  if (sha === undefined) {
    throw new ArgParseError("--sha is required");
  }
  if (targetRef === undefined) {
    throw new ArgParseError("--target-ref is required");
  }
  if (env === undefined) {
    throw new ArgParseError("--env is required");
  }
  if (status === undefined) {
    throw new ArgParseError("--status is required");
  }
  if (startedAtMs === undefined) {
    throw new ArgParseError("--started-at is required");
  }

  if (service.length > SERVICE_MAX || !SERVICE_RE.test(service)) {
    throw new ArgParseError(
      `--service must be 1..${SERVICE_MAX} chars matching ${SERVICE_RE.source}`,
    );
  }
  if (env.length > ENV_MAX || !ENV_RE.test(env)) {
    throw new ArgParseError(`--env must be 1..${ENV_MAX} chars matching ${ENV_RE.source}`);
  }
  if (!SHA_RE.test(sha)) {
    throw new ArgParseError("--sha must be 7..64 lowercase hex chars");
  }

  return {
    service,
    sha,
    targetRef,
    env,
    status,
    startedAtMs,
    finishedAtMs,
    workflowUrl,
    provider,
    runId,
    jobId,
    json,
  };
}

interface AnnotateResultEnvelope {
  readonly external_id: string;
  readonly service: string;
  readonly stored_at_ms: number;
  readonly is_new: boolean;
  readonly dora_eligible: boolean;
}

function isAnnotateResult(value: unknown): value is AnnotateResultEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["external_id"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["stored_at_ms"] === "number" &&
    typeof v["is_new"] === "boolean" &&
    typeof v["dora_eligible"] === "boolean"
  );
}

function shouldUseColor(): boolean {
  if (process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "") return false;
  return process.stdout.isTTY === true;
}

function formatPretty(result: AnnotateResultEnvelope, useColor: boolean): string {
  const tick = useColor ? "\x1b[32m✓\x1b[0m" : "✓";
  const suffix = result.dora_eligible ? " (DORA-eligible)" : "";
  return `${tick} Deployment recorded: ${result.external_id}${suffix}`;
}

export async function runDeployAnnotate(argv: readonly string[]): Promise<number> {
  let parsed: DeployAnnotateArgs;
  try {
    parsed = parseDeployAnnotateArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${msg}\n`);
    return 2;
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    return 1;
  }

  const payload: Record<string, unknown> = {
    service: parsed.service,
    provider: parsed.provider,
    environment: parsed.env,
    sha: parsed.sha,
    ref: parsed.targetRef,
    status: parsed.status,
    started_at_ms: parsed.startedAtMs,
  };
  if (parsed.finishedAtMs !== undefined) payload["finished_at_ms"] = parsed.finishedAtMs;
  if (parsed.workflowUrl !== undefined) payload["workflow_url"] = parsed.workflowUrl;
  if (parsed.runId !== undefined) payload["run_id"] = parsed.runId;
  if (parsed.jobId !== undefined) payload["job_id"] = parsed.jobId;

  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    const result = await client.call<unknown>("deployment.annotate", payload);
    if (!isAnnotateResult(result)) {
      process.stderr.write("deployment.annotate returned a malformed envelope\n");
      return 1;
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatPretty(result, shouldUseColor())}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await client.disconnect().catch(() => {});
  }
}
