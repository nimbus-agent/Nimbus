import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { runDeployAnnotate } from "./deploy-annotate.ts";

export type DeployPreflightMode = "warn" | "block" | "off";

export type DeployPreflightArgs = {
  readonly service: string;
  readonly targetRef: string;
  readonly mode: DeployPreflightMode;
  readonly json: boolean;
};

const MODES: ReadonlySet<DeployPreflightMode> = new Set(["warn", "block", "off"]);

export function parseDeployPreflightArgs(args: readonly string[]): DeployPreflightArgs {
  let service: string | undefined;
  let targetRef: string | undefined;
  let mode: DeployPreflightMode = "warn";
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
    if (a === "--target-ref") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error("--target-ref requires a non-empty value");
      }
      targetRef = v.trim();
      i += 1;
      continue;
    }
    if (a === "--mode") {
      const v = args[i + 1];
      if (typeof v !== "string" || !MODES.has(v as DeployPreflightMode)) {
        throw new Error("--mode must be one of: warn, block, off");
      }
      mode = v as DeployPreflightMode;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
    }
  }
  if (service === undefined) {
    throw new Error(
      "Usage: nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn|block|off] [--json]",
    );
  }
  if (targetRef === undefined) {
    throw new Error(
      "Usage: nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn|block|off] [--json]",
    );
  }
  return { service, targetRef, mode, json };
}

type Finding = { id: string; title: string; url: string | null };
type CheckShape = {
  count: number;
  findings: readonly Finding[];
  gap: string | null;
};
type Envelope = {
  service: string;
  target_ref: string;
  verdict: "ok" | "warn";
  computed_at: string;
  checks: Record<string, CheckShape>;
};

function isEnvelope(x: unknown): x is Envelope {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["service"] === "string" &&
    typeof o["target_ref"] === "string" &&
    (o["verdict"] === "ok" || o["verdict"] === "warn") &&
    typeof o["checks"] === "object" &&
    o["checks"] !== null
  );
}

function shouldUseColor(): boolean {
  if (process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "") return false;
  return process.stdout.isTTY === true;
}

function formatPretty(env: Envelope, useColor: boolean): string {
  const lines: string[] = [];
  const verdictTag =
    env.verdict === "ok"
      ? useColor
        ? "\x1b[32m[ok]\x1b[0m"
        : "[ok]"
      : useColor
        ? "\x1b[33m[warn]\x1b[0m"
        : "[warn]";
  lines.push(`Deploy preflight — ${env.service} @ ${env.target_ref}  ${verdictTag}`);
  lines.push("");
  const labels: Record<string, string> = {
    active_p1_incidents: "Active P1 incidents",
    failing_ci_runs: "Failing CI runs",
    merge_conflicts: "Open PR merge conflicts",
  };
  const keys = ["active_p1_incidents", "failing_ci_runs", "merge_conflicts"] as const;
  for (const key of keys) {
    const m = env.checks[key];
    if (m === undefined) continue;
    const label = labels[key];
    if (label === undefined) continue;
    const gap = m.gap === null ? "" : useColor ? `\x1b[2m[${m.gap}]\x1b[0m` : `[${m.gap}]`;
    lines.push(`  ${label.padEnd(28)} ${String(m.count).padStart(4)}  ${gap}`);
    for (const f of m.findings.slice(0, 3)) {
      lines.push(`      • ${f.title}${f.url ? `  ${f.url}` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function runDeployCli(args: readonly string[]): Promise<void> {
  if (args[0] === "annotate") {
    const exitCode = await runDeployAnnotate(args.slice(1));
    process.exit(exitCode);
  }
  if (args[0] !== "preflight") {
    process.stderr.write(
      "Usage: nimbus deploy preflight --service <id> --target-ref <ref>\n" +
        "       nimbus deploy annotate  --service <id> --sha <sha> --target-ref <ref> --env <env> --status <s> --started-at <ms>\n",
    );
    process.exit(1);
  }
  let parsed: DeployPreflightArgs;
  try {
    parsed = parseDeployPreflightArgs(args.slice(1));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(2);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    const result = await client.call<unknown>("deploy.preflight", {
      service: parsed.service,
      target_ref: parsed.targetRef,
    });
    if (!isEnvelope(result)) {
      process.stderr.write("deploy.preflight returned a malformed envelope\n");
      process.exit(2);
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatPretty(result, shouldUseColor())}\n`);
    }
    if (parsed.mode === "block" && result.verdict === "warn") {
      process.exit(1);
    }
    // warn (default) and off → exit 0 regardless of verdict
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
