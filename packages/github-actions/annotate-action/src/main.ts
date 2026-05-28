import { appendFileSync } from "node:fs";
import { setOutput } from "./output.ts";
import { type AnnotateResult, renderSummary } from "./render.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit byte ranges define the sanitizer barrier
const DENY_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function safeString(raw: unknown, maxLen: number): string {
  const s = typeof raw === "string" ? raw : "";
  return s.replace(DENY_CHARS, "").slice(0, maxLen);
}

function safeInt(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function safeBool(raw: unknown): boolean {
  return raw === true;
}

type SanitizedAnnotateEnvelope = {
  external_id: string;
  service: string;
  stored_at_ms: number;
  is_new: boolean;
  dora_eligible: boolean;
};

function safeAnnotateEnvelope(raw: unknown): SanitizedAnnotateEnvelope {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    external_id: safeString(o.external_id, 512),
    service: safeString(o.service, 64),
    stored_at_ms: safeInt(o.stored_at_ms),
    is_new: safeBool(o.is_new),
    dora_eligible: safeBool(o.dora_eligible),
  };
}

function getInput(name: string): string {
  const envName = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  return process.env[envName] ?? "";
}

function getBooleanInput(name: string): boolean {
  const raw = getInput(name).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function getIntInput(name: string, fallback: number): number {
  const raw = getInput(name);
  if (raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : fallback;
}

const STEP_SUMMARY_MAX_BYTES = 64 * 1024;

function writeJobSummary(md: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file === undefined) return;
  const safe = md.length > STEP_SUMMARY_MAX_BYTES ? md.slice(0, STEP_SUMMARY_MAX_BYTES) : md;
  appendFileSync(file, `${safe}\n`);
}

function emitAnnotation(level: "warning" | "error", message: string): void {
  process.stdout.write(`::${level}::${message}\n`);
}

type PostOk = {
  status: "ok";
  envelope: AnnotateResult & { service: string; stored_at_ms: number };
};
type PostUnreachable = { status: "unreachable"; retryAfter?: string; body?: string };
type PostAuthFailed = { status: "auth_failed" };
type PostRateLimited = { status: "rate_limited"; retryAfter?: string };
type PostSurfaceDisabled = { status: "surface_disabled"; hint?: string };

type PostResult = PostOk | PostUnreachable | PostAuthFailed | PostRateLimited | PostSurfaceDisabled;

interface AnnotatePayload {
  service: string;
  provider: "github-actions";
  environment: string;
  sha: string;
  ref: string;
  status: string;
  started_at_ms: number;
  finished_at_ms?: number;
  workflow_url?: string;
  run_id?: string;
  job_id?: string;
}

async function postAnnotation(
  gatewayUrl: string,
  token: string,
  payload: AnnotatePayload,
  timeoutMs: number,
): Promise<PostResult> {
  const url = new URL("/v1/deployments", gatewayUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 200) {
      const envelope = (await res.json()) as AnnotateResult & {
        service: string;
        stored_at_ms: number;
      };
      return { status: "ok", envelope };
    }
    if (res.status === 401) {
      await res.text();
      return { status: "auth_failed" };
    }
    if (res.status === 429) {
      await res.text();
      const retryAfter = res.headers.get("retry-after");
      return retryAfter === null
        ? { status: "rate_limited" }
        : { status: "rate_limited", retryAfter };
    }
    if (res.status === 503) {
      let hint: string | undefined;
      try {
        const body = (await res.json()) as { error?: unknown; hint?: unknown };
        if (typeof body.hint === "string") hint = body.hint;
      } catch {
        /* not json — leave hint undefined */
      }
      return hint === undefined
        ? { status: "surface_disabled" }
        : { status: "surface_disabled", hint };
    }
    const body = await res.text();
    return { status: "unreachable", body: `${res.status} ${body.slice(0, 200)}` };
  } catch (e) {
    return {
      status: "unreachable",
      body: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function main(): Promise<void> {
  const service = getInput("service");
  if (service === "") {
    emitAnnotation("error", "missing required input: service");
    process.exit(1);
  }
  const environment = getInput("environment");
  if (environment === "") {
    emitAnnotation("error", "missing required input: environment");
    process.exit(1);
  }
  const status = getInput("status");
  if (status === "") {
    emitAnnotation("error", "missing required input: status");
    process.exit(1);
  }
  const token = getInput("token");
  if (token === "") {
    emitAnnotation("error", "missing required input: token");
    process.exit(1);
  }

  const sha = getInput("sha");
  const targetRef = getInput("target-ref");
  const workflowUrl = getInput("workflow-url");
  const runId = getInput("run-id");
  const jobId = getInput("job-id");
  const startedAtRaw = getInput("started-at");
  const finishedAtRaw = getInput("finished-at");
  const gatewayUrl = getInput("gateway-url") || "http://localhost:7474";
  const timeoutMs = getIntInput("timeout-ms", 10_000);
  const allowGatewayFailure = getBooleanInput("allow-gateway-failure");

  const startedAtMs = startedAtRaw === "" ? Date.now() : Number.parseInt(startedAtRaw, 10);
  if (!Number.isFinite(startedAtMs)) {
    emitAnnotation(
      "error",
      `invalid input: started-at must be a unix-ms integer, got '${startedAtRaw}'`,
    );
    process.exit(1);
  }

  const payload: AnnotatePayload = {
    service,
    provider: "github-actions",
    environment,
    sha,
    ref: targetRef,
    status,
    started_at_ms: startedAtMs,
  };
  if (finishedAtRaw !== "") {
    const finishedAtMs = Number.parseInt(finishedAtRaw, 10);
    if (!Number.isFinite(finishedAtMs)) {
      emitAnnotation(
        "error",
        `invalid input: finished-at must be a unix-ms integer, got '${finishedAtRaw}'`,
      );
      process.exit(1);
    }
    payload.finished_at_ms = finishedAtMs;
  }
  if (workflowUrl !== "") payload.workflow_url = workflowUrl;
  if (runId !== "") payload.run_id = runId;
  if (jobId !== "") payload.job_id = jobId;

  const result = await postAnnotation(gatewayUrl, token, payload, timeoutMs);

  if (result.status === "ok") {
    const env = safeAnnotateEnvelope(result.envelope);
    setOutput("external-id", env.external_id);
    setOutput("is-new", env.is_new ? "true" : "false");
    setOutput("dora-eligible", env.dora_eligible ? "true" : "false");
    writeJobSummary(
      renderSummary({
        service: env.service,
        environment: safeString(environment, 64),
        status: safeString(status, 32),
        externalId: env.external_id,
        isNew: env.is_new,
        doraEligible: env.dora_eligible,
      }),
    );
    process.exit(0);
  }

  let warning: string;
  if (result.status === "auth_failed") {
    warning =
      "Nimbus Gateway rejected the bearer token (401). Confirm the GitHub secret matches the vault key " +
      "http_api.deployment_token configured via 'nimbus vault set http_api.deployment_token <value>'.";
  } else if (result.status === "rate_limited") {
    const retry = result.retryAfter === undefined ? "" : ` Retry-After: ${result.retryAfter}s.`;
    warning = `Nimbus Gateway rate-limited the annotation (429).${retry}`;
  } else if (result.status === "surface_disabled") {
    const hint =
      result.hint === undefined
        ? "set http_api.deployment_token via 'nimbus vault set http_api.deployment_token <value>'"
        : result.hint;
    warning = `Nimbus deployment write surface is disabled (503): ${hint}`;
  } else {
    const detail = result.body === undefined ? "" : `: ${result.body.slice(0, 200)}`;
    warning = `Nimbus Gateway unreachable at ${gatewayUrl}${detail}`;
  }
  emitAnnotation("warning", warning);

  if (allowGatewayFailure) {
    process.exit(0);
  }
  process.exit(1);
}

await main();
