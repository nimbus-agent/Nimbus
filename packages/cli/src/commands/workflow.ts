import { readFileSync } from "node:fs";

import { IPCClient } from "../ipc-client/index.ts";
import { hasFlag, shiftFlag } from "../lib/flag-parsing.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerAgentChunkStdout } from "../lib/interactive-ipc-handlers.ts";
import { parseWorkflowFileContent } from "../lib/workflow-parse.ts";
import { getCliPlatformPaths } from "../paths.ts";

export async function runWorkflowList(client: IPCClient): Promise<void> {
  const out = await client.call<{ workflows: unknown }>("workflow.list", {});
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runWorkflowDelete(client: IPCClient, rest: string[]): Promise<void> {
  const name = rest[0]?.trim() ?? "";
  if (name === "") {
    throw new Error("Usage: nimbus workflow delete <name>");
  }
  const out = await client.call<{ ok: boolean }>("workflow.delete", { name });
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runWorkflowSave(client: IPCClient, rest: string[]): Promise<void> {
  const name = rest[0]?.trim() ?? "";
  const tail = rest.slice(1);
  const file = shiftFlag(tail, "--file");
  if (name === "" || file === undefined || file === "") {
    throw new Error("Usage: nimbus workflow save <name> --file <path> [--description text]");
  }
  const description = shiftFlag(tail, "--description");
  const content = readFileSync(file, "utf8");
  const parsed = parseWorkflowFileContent(content, file);
  if (parsed.name !== name) {
    console.warn(
      `Note: file declares name "${parsed.name}"; saving under CLI name "${name}" as requested.`,
    );
  }
  let desc: string | null = null;
  if (description !== undefined && description !== "") {
    desc = description;
  } else if (parsed.description !== null) {
    desc = parsed.description;
  }
  const savePayload: Record<string, unknown> = { name, stepsJson: parsed.stepsJson };
  if (desc !== null) {
    savePayload["description"] = desc;
  }
  const out = await client.call("workflow.save", savePayload);
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runWorkflowRun(client: IPCClient, rest: string[]): Promise<void> {
  const name = rest[0]?.trim() ?? "";
  const tail = rest.slice(1);
  if (name === "") {
    throw new Error(
      "Usage: nimbus workflow run <name> [--dry-run] [--no-ttv] [--agent nimbus|devops|research]",
    );
  }
  const dryRun = hasFlag(tail, "--dry-run");
  const noTtv = hasFlag(tail, "--no-ttv");
  const agentArg = shiftFlag(tail, "--agent");
  let agent: string | undefined;
  if (agentArg !== undefined && agentArg !== "") {
    agent = agentArg;
  }

  registerAgentChunkStdout(client);

  if (noTtv && !dryRun) {
    const preview = await client.call("workflow.run", {
      name,
      stream: false,
      dryRun: true,
      ...(agent === undefined ? {} : { agent }),
    });
    const rec = preview as { stepResults?: Array<{ hitlActions?: readonly string[] }> };
    const flagged = (rec.stepResults ?? []).filter((s) => (s.hitlActions?.length ?? 0) > 0);
    if (flagged.length > 0) {
      throw new Error(
        "Workflow steps may require human approval (HITL). Omit --no-ttv to run, or use --dry-run to inspect hitlActions.",
      );
    }
  }

  const runPayload: Record<string, unknown> = {
    name,
    stream: dryRun === false,
    dryRun,
  };
  if (agent !== undefined) {
    runPayload["agent"] = agent;
  }
  const out = await client.call("workflow.run", runPayload);
  console.log(`\n${JSON.stringify(out, undefined, 2)}`);
}

async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

export async function runWorkflowCli(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const rest = args.slice(1);

  if (sub === "list" || sub === "") {
    await withIpc((c) => runWorkflowList(c));
    return;
  }
  if (sub === "delete") {
    await withIpc((c) => runWorkflowDelete(c, rest));
    return;
  }
  if (sub === "save") {
    await withIpc((c) => runWorkflowSave(c, rest));
    return;
  }
  if (sub === "run") {
    await withIpc((c) => runWorkflowRun(c, rest));
    return;
  }

  throw new Error(
    "Usage: nimbus workflow list | save <name> --file <path> | run <name> | delete <name>",
  );
}
