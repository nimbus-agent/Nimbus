import { readFileSync } from "node:fs";

import type { IPCClient } from "../ipc-client/index.ts";
import { hasFlag, shiftFlag } from "../lib/flag-parsing.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { createIpcClient, INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { parseWorkflowFileContent } from "../lib/workflow-parse.ts";
import { getCliPlatformPaths } from "../paths.ts";

function buildWorkflowRunPayload(
  name: string,
  dryRun: boolean,
  agent: string | undefined,
): Record<string, unknown> {
  const runPayload: Record<string, unknown> = {
    name,
    stream: dryRun === false,
    dryRun,
  };
  if (agent !== undefined && agent !== "") {
    runPayload["agent"] = agent;
  }
  return runPayload;
}

export type RunWorkflowOptions = {
  readonly dryRun: boolean;
  readonly noTtv: boolean;
  readonly agent: string | undefined;
};

function parseRunFlags(args: string[]): RunWorkflowOptions {
  const tail = args.slice();
  const dryRun = hasFlag(tail, "--dry-run");
  const noTtv = hasFlag(tail, "--no-ttv");
  const agentArg = shiftFlag(tail, "--agent");
  let agent: string | undefined;
  if (agentArg !== undefined && agentArg !== "") {
    agent = agentArg;
  }
  return { dryRun, noTtv, agent };
}

export async function runWorkflowFromFileWithClient(
  client: IPCClient,
  file: string,
  opts: RunWorkflowOptions,
): Promise<void> {
  const content = readFileSync(file, "utf8");
  const parsed = parseWorkflowFileContent(content, file);

  registerInteractiveCliIpcHandlers(client);

  const savePayload: Record<string, unknown> = {
    name: parsed.name,
    stepsJson: parsed.stepsJson,
  };
  if (parsed.description !== null) {
    savePayload["description"] = parsed.description;
  }
  await client.call("workflow.save", savePayload);

  if (opts.noTtv && !opts.dryRun) {
    const preview = await client.call(
      "workflow.run",
      buildWorkflowRunPayload(parsed.name, true, opts.agent),
    );
    const rec = preview as { stepResults?: Array<{ hitlActions?: readonly string[] }> };
    const flagged = (rec.stepResults ?? []).filter((s) => (s.hitlActions?.length ?? 0) > 0);
    if (flagged.length > 0) {
      throw new Error(
        "Workflow steps may require human approval (HITL). Omit --no-ttv to run, or use --dry-run to inspect hitlActions.",
      );
    }
  }

  const out = await client.call(
    "workflow.run",
    buildWorkflowRunPayload(parsed.name, opts.dryRun, opts.agent),
  );
  console.log(`\n${JSON.stringify(out, undefined, 2)}`);
}

export async function runWorkflowFromFile(args: string[]): Promise<void> {
  const file = args[0]?.trim() ?? "";
  if (file === "") {
    throw new Error(
      "Usage: nimbus run <workflow.json|yaml> [--dry-run] [--no-ttv] [--agent nimbus|devops|research]",
    );
  }
  const opts = parseRunFlags(args.slice(1));

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }

  // `workflow.run` is awaited by the Gateway for the whole run, and a HITL step is
  // answered at a prompt that runs inside that pending call.
  const client = createIpcClient(state.socketPath, INTERACTIVE_RPC_TIMEOUT_MS);
  await client.connect();
  try {
    await runWorkflowFromFileWithClient(client, file, opts);
  } finally {
    await client.disconnect();
  }
}
