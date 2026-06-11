import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { isPreflightBrief, type PreflightBrief } from "../types/agents.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

// Downstream owners approve interactively, so the upstream call blocks on human responses.
const PREFLIGHT_TIMEOUT_MS = 600_000; // 10 min

export type PreflightCliArgs =
  | { mode: "run"; ref: string; namespace: string; strict: boolean; json: boolean }
  | { mode: "approve"; requestId: string };

export function parsePreflightArgs(args: string[]): PreflightCliArgs {
  if (args[0] === "approve") {
    const requestId = args[1];
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.startsWith("--")) {
      throw new Error("Usage: nimbus preflight approve <request-id>");
    }
    return { mode: "approve", requestId };
  }
  const positional: string[] = [];
  let namespace = "";
  let strict = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--strict") strict = true;
    else if (a === "--namespace") {
      namespace = flagValue(args, i, "--namespace");
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) positional.push(a);
  }
  const ref = positional.join(" ").trim();
  if (ref.length === 0) {
    throw new Error("Usage: nimbus preflight <ref> --namespace <ns> [--strict] [--json]");
  }
  if (namespace.length === 0) throw new Error("nimbus preflight requires --namespace <ns>");
  return { mode: "run", ref, namespace, strict, json };
}

async function approve(requestId: string): Promise<void> {
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  try {
    await client.connect();
    const out = await client.call<{ matched: boolean }>("federation.preflightRespond", {
      requestId,
      approved: true,
    });
    process.stdout.write(out.matched ? "approved\n" : "no pending request with that id\n");
  } finally {
    await client.disconnect();
  }
}

export async function runPreflightCli(args: string[]): Promise<void> {
  const parsed = parsePreflightArgs(args);
  if (parsed.mode === "approve") {
    await approve(parsed.requestId);
    return;
  }
  await runAgentBriefCli<PreflightBrief>({
    kind: "preflight",
    guard: isPreflightBrief,
    json: parsed.json,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    params: { ref: parsed.ref, namespace: parsed.namespace },
    // Exit-code contract (§4.5): non-zero if any downstream's tests failed; with --strict also fail
    // on incomplete coverage (declined / not-configured / unreachable). process.exitCode (not exit)
    // so stdout flushes first.
    onResult: (f) => {
      if (f.anyFailed || (parsed.strict && f.anyIncomplete)) process.exitCode = 1;
    },
  });
}
