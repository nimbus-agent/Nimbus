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

interface MutableDeployAnnotateArgs {
  service?: string;
  sha?: string;
  targetRef?: string;
  env?: string;
  status?: DeployAnnotateStatus;
  startedAtMs?: number;
  finishedAtMs?: number;
  workflowUrl?: string;
  provider: DeployAnnotateProvider;
  runId?: string;
  jobId?: string;
  json: boolean;
}

function parseStatusValue(raw: string): DeployAnnotateStatus {
  const v = raw.trim();
  if (!STATUS_VALUES.has(v as DeployAnnotateStatus)) {
    throw new ArgParseError("--status must be one of: success, failure, cancelled, in_progress");
  }
  return v as DeployAnnotateStatus;
}

function parseProviderValue(raw: string): DeployAnnotateProvider {
  const v = raw.trim();
  if (!PROVIDER_VALUES.has(v as DeployAnnotateProvider)) {
    throw new ArgParseError(
      "--provider must be one of: github-actions, gitlab, jenkins, circleci, bitbucket, other",
    );
  }
  return v as DeployAnnotateProvider;
}

const VALUE_FLAG_SETTERS: Record<
  string,
  (out: MutableDeployAnnotateArgs, flag: string, raw: string | undefined) => void
> = {
  "--service": (out, flag, raw) => {
    out.service = requireValue(flag, raw).trim();
  },
  "--sha": (out, flag, raw) => {
    out.sha = requireValue(flag, raw).trim().toLowerCase();
  },
  "--target-ref": (out, flag, raw) => {
    out.targetRef = requireValue(flag, raw).trim();
  },
  "--env": (out, flag, raw) => {
    out.env = requireValue(flag, raw).trim();
  },
  "--status": (out, flag, raw) => {
    out.status = parseStatusValue(requireValue(flag, raw));
  },
  "--started-at": (out, flag, raw) => {
    out.startedAtMs = parseIntegerMs(flag, requireValue(flag, raw));
  },
  "--finished-at": (out, flag, raw) => {
    out.finishedAtMs = parseIntegerMs(flag, requireValue(flag, raw));
  },
  "--workflow-url": (out, flag, raw) => {
    out.workflowUrl = requireValue(flag, raw).trim();
  },
  "--provider": (out, flag, raw) => {
    out.provider = parseProviderValue(requireValue(flag, raw));
  },
  "--run-id": (out, flag, raw) => {
    out.runId = requireValue(flag, raw).trim();
  },
  "--job-id": (out, flag, raw) => {
    out.jobId = requireValue(flag, raw).trim();
  },
};

function validateDeployAnnotateArgs(out: MutableDeployAnnotateArgs): DeployAnnotateArgs {
  const required: ReadonlyArray<[keyof MutableDeployAnnotateArgs, string]> = [
    ["service", "--service is required"],
    ["sha", "--sha is required"],
    ["targetRef", "--target-ref is required"],
    ["env", "--env is required"],
    ["status", "--status is required"],
    ["startedAtMs", "--started-at is required"],
  ];
  for (const [key, message] of required) {
    if (out[key] === undefined) throw new ArgParseError(message);
  }
  const { service, sha, env } = out as Required<
    Pick<MutableDeployAnnotateArgs, "service" | "sha" | "env">
  >;

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

  return out as DeployAnnotateArgs;
}

export function parseDeployAnnotateArgs(argv: readonly string[]): DeployAnnotateArgs {
  const out: MutableDeployAnnotateArgs = { provider: "other", json: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    const setter = a === undefined ? undefined : VALUE_FLAG_SETTERS[a];
    if (setter !== undefined && a !== undefined) {
      setter(out, a, argv[i + 1]);
      i += 1;
      continue;
    }
    if (typeof a === "string" && a.startsWith("--")) {
      throw new ArgParseError(`unknown flag: ${a}`);
    }
  }

  return validateDeployAnnotateArgs(out);
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
