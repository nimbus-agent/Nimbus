import {
  emitAnnotation,
  getBooleanInput,
  getInput,
  getIntInput,
  safeInt,
  safeString,
  writeJobSummary,
} from "../../shared/gha-io.ts";
import { setOutput } from "./output.ts";
import {
  decideExitCode,
  type Envelope,
  type PreflightMode,
  renderAnnotations,
  renderJobSummary,
} from "./render.ts";

// Re-exported so this package's unit tests can import the pure helpers from main.ts.
export { getBooleanInput, getInput, getIntInput, safeString };

/**
 * Fails CLOSED: only the literal `"ok"` yields `"ok"`.
 *
 * This previously read `raw === "warn" ? "warn" : "ok"`, so every value it did not recognise —
 * a verdict the gateway adds later, a typo, a truncated body, `undefined` — became `ok`, and
 * `decideExitCode` then let a `--mode block` run pass. An unrecognised verdict is precisely the
 * case where this Action cannot tell whether it is safe to deploy, so the safe default is the one
 * that blocks. See F24a.
 *
 * Keep the direction of this test when adding a verdict value: widen the `"ok"` arm only for
 * values that genuinely mean "nothing wrong", never by re-inverting the default.
 */
function safeVerdict(raw: unknown): "ok" | "warn" {
  return raw === "ok" ? "ok" : "warn";
}

type SanitizedFinding = {
  id: string;
  title: string;
  url: string | null;
};

function safeFindings(
  raw: readonly { id: string; title: string; url?: string | null }[],
): SanitizedFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => ({
    id: safeString(f.id, 256),
    title: safeString(f.title, 512),
    url: typeof f.url === "string" && f.url.length > 0 ? safeString(f.url, 2048) : null,
  }));
}

export function sanitizeEnvelope(raw: Envelope): Envelope {
  return {
    service: safeString(raw.service, 128),
    target_ref: safeString(raw.target_ref, 256),
    computed_at: safeString(raw.computed_at, 64),
    verdict: safeVerdict(raw.verdict),
    checks: {
      active_p1_incidents: {
        count: safeInt(raw.checks.active_p1_incidents.count),
        findings: safeFindings(raw.checks.active_p1_incidents.findings),
        gap:
          typeof raw.checks.active_p1_incidents.gap === "string"
            ? safeString(raw.checks.active_p1_incidents.gap, 64)
            : null,
      },
      failing_ci_runs: {
        count: safeInt(raw.checks.failing_ci_runs.count),
        findings: safeFindings(raw.checks.failing_ci_runs.findings),
        gap:
          typeof raw.checks.failing_ci_runs.gap === "string"
            ? safeString(raw.checks.failing_ci_runs.gap, 64)
            : null,
      },
      merge_conflicts: {
        count: safeInt(raw.checks.merge_conflicts.count),
        findings: safeFindings(raw.checks.merge_conflicts.findings),
        gap:
          typeof raw.checks.merge_conflicts.gap === "string"
            ? safeString(raw.checks.merge_conflicts.gap, 64)
            : null,
      },
    },
  };
}

export function parseMode(raw: string): PreflightMode {
  if (raw === "block" || raw === "off") return raw;
  return "warn";
}

async function fetchEnvelope(
  gatewayUrl: string,
  service: string,
  targetRef: string,
  maxFindings: number,
  timeoutMs: number,
): Promise<{ status: "ok"; envelope: Envelope } | { status: "unreachable" }> {
  const url = new URL("/v1/preflight/deploy", gatewayUrl);
  url.searchParams.set("service", service);
  url.searchParams.set("target_ref", targetRef);
  url.searchParams.set("max_findings", String(maxFindings));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      emitAnnotation(
        "warning",
        `Gateway returned ${res.status} for /v1/preflight/deploy: ${body.slice(0, 200)}`,
      );
      return { status: "unreachable" };
    }
    const envelope = (await res.json()) as Envelope;
    return { status: "ok", envelope };
  } catch (e) {
    emitAnnotation(
      "warning",
      `Nimbus Gateway unreachable at ${gatewayUrl}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { status: "unreachable" };
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
  const targetRef = getInput("target-ref");
  if (targetRef === "") {
    emitAnnotation("error", "missing required input: target-ref");
    process.exit(1);
  }
  const gatewayUrl = getInput("gateway-url") || "http://localhost:7474";
  const mode = parseMode(getInput("mode"));
  const maxFindings = getIntInput("max-findings", 10);
  const timeoutMs = getIntInput("timeout-ms", 10_000);
  const allowGatewayFailure = getBooleanInput("allow-gateway-failure");

  const fetched = await fetchEnvelope(gatewayUrl, service, targetRef, maxFindings, timeoutMs);

  if (fetched.status === "unreachable") {
    const code = decideExitCode({
      verdict: "ok",
      mode,
      unreachable: true,
      allowGatewayFailure,
    });
    const nonBlockVerdict = mode === "off" ? "ok" : "warn";
    setOutput("verdict", code === 1 ? "block" : nonBlockVerdict);
    setOutput("result-json", "{}");
    process.exit(code);
  }

  const env = sanitizeEnvelope(fetched.envelope);
  writeJobSummary(renderJobSummary(env));
  for (const ann of renderAnnotations(env, mode)) {
    const msg = ann.url ? `${ann.message} — ${ann.url}` : ann.message;
    emitAnnotation(ann.level, msg);
  }

  setOutput("verdict", env.verdict === "warn" && mode === "block" ? "block" : env.verdict);
  setOutput("incident-count", String(env.checks.active_p1_incidents.count));
  setOutput("failing-ci-count", String(env.checks.failing_ci_runs.count));
  setOutput("merge-conflict-count", String(env.checks.merge_conflicts.count));
  setOutput("result-json", JSON.stringify(env));

  const code = decideExitCode({
    verdict: env.verdict,
    mode,
    unreachable: false,
    allowGatewayFailure,
  });
  process.exit(code);
}

// Run only as the action entrypoint, so unit tests can import the pure helpers
// above without triggering a real gateway fetch + process.exit.
if (import.meta.main) {
  await main();
}
