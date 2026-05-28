import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type MetricsDoraArgs = {
  service: string;
  since: string;
  json: boolean;
};

const SINCE_RE = /^\d+[dh]$/;

export function parseMetricsDoraArgs(args: string[]): MetricsDoraArgs {
  let service: string | undefined;
  let since = "30d";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--service") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error("--service requires a non-empty value");
      }
      service = v.trim();
      i += 1;
      continue;
    }
    if (a === "--since") {
      const v = args[i + 1];
      if (typeof v !== "string" || !SINCE_RE.test(v)) {
        throw new Error("--since must match \\d+(d|h), e.g. '30d' or '24h'");
      }
      since = v;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
    }
  }
  if (service === undefined) {
    throw new Error("Usage: nimbus metrics dora --service <id> [--since 30d] [--json]");
  }
  return { service, since, json };
}

type DoraMetricEnvelope = {
  value: number | null;
  unit: string;
  sample: number;
  gap: string | null;
};

type DoraEnvelope = {
  service: string;
  since_ms: number;
  computed_at: string;
  metrics: {
    deployment_frequency: DoraMetricEnvelope;
    lead_time_for_changes: DoraMetricEnvelope;
    change_failure_rate: DoraMetricEnvelope;
    mttr: DoraMetricEnvelope;
  };
};

function isDoraMetricEnvelope(value: unknown): value is DoraMetricEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const valueOk = v["value"] === null || typeof v["value"] === "number";
  const unitOk = typeof v["unit"] === "string";
  const sampleOk = typeof v["sample"] === "number" && Number.isFinite(v["sample"]);
  const gapOk = v["gap"] === null || typeof v["gap"] === "string";
  return valueOk && unitOk && sampleOk && gapOk;
}

function isDoraEnvelope(value: unknown): value is DoraEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v["service"] !== "string") return false;
  if (typeof v["since_ms"] !== "number") return false;
  if (typeof v["computed_at"] !== "string") return false;
  const m = v["metrics"];
  if (m === null || typeof m !== "object") return false;
  const ms = m as Record<string, unknown>;
  return (
    isDoraMetricEnvelope(ms["deployment_frequency"]) &&
    isDoraMetricEnvelope(ms["lead_time_for_changes"]) &&
    isDoraMetricEnvelope(ms["change_failure_rate"]) &&
    isDoraMetricEnvelope(ms["mttr"])
  );
}

const LABELS: Record<keyof DoraEnvelope["metrics"], string> = {
  deployment_frequency: "Deployment Frequency",
  lead_time_for_changes: "Lead Time",
  change_failure_rate: "Change Failure Rate",
  mttr: "MTTR",
};

const METRIC_ORDER: ReadonlyArray<keyof DoraEnvelope["metrics"]> = [
  "deployment_frequency",
  "lead_time_for_changes",
  "change_failure_rate",
  "mttr",
];

export interface RenderOptions {
  readonly tty: boolean;
  readonly noColor: boolean;
}

export interface MetricRowInput {
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: string | null;
}

export function renderMetricRow(metric: MetricRowInput, options: RenderOptions): string {
  const useColor = options.tty && !options.noColor;
  const valueStr = metric.value === null ? "—" : metric.value.toFixed(3);
  const gapStr =
    metric.gap === null ? "" : useColor ? `\x1b[33m[${metric.gap}]\x1b[0m` : `[${metric.gap}]`;
  const prefix = metric.gap === "mixed_source" && useColor ? "\x1b[33m⚠\x1b[0m " : "";
  return `  ${prefix}${metric.label.padEnd(20)} ${valueStr.padStart(10)} ${metric.unit.padEnd(20)} n=${String(metric.sample)}  ${gapStr}`;
}

export function renderMixedSourceHint(): string {
  return [
    "Note: this window contains both explicit `deployment` annotations and ci_run regex matches.",
    "Annotated rows are counted; ci_run rows are ignored. Annotate consistently for accurate DF/LT.",
  ].join("\n");
}

export function formatDoraPretty(env: DoraEnvelope, options: RenderOptions): string {
  const sinceDays = Math.floor(env.since_ms / 86_400_000);
  const lines: string[] = [];
  lines.push(`DORA metrics — ${env.service} (since ${sinceDays}d)`);
  lines.push("");
  let hasMixedSource = false;
  for (const key of METRIC_ORDER) {
    const m = env.metrics[key];
    if (m.gap === "mixed_source") hasMixedSource = true;
    lines.push(
      renderMetricRow(
        {
          label: LABELS[key],
          value: m.value,
          unit: m.unit,
          sample: m.sample,
          gap: m.gap,
        },
        options,
      ),
    );
  }
  if (hasMixedSource) {
    lines.push("");
    lines.push(renderMixedSourceHint());
  }
  return lines.join("\n");
}

export async function runMetricsCli(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "dora") {
    process.stderr.write("Usage: nimbus metrics dora --service <id> [--since 30d] [--json]\n");
    process.exit(1);
  }
  let parsed: MetricsDoraArgs;
  try {
    parsed = parseMetricsDoraArgs(args.slice(1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();

  try {
    const result = await client.call<unknown>("metrics.dora", {
      service: parsed.service,
      since: parsed.since,
    });
    if (!isDoraEnvelope(result)) {
      process.stderr.write("Malformed metrics.dora response\n");
      process.exit(2);
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const noColor = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";
    const tty = process.stdout.isTTY === true;
    process.stdout.write(`${formatDoraPretty(result, { tty, noColor })}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
