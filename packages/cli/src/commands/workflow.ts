import { readFileSync } from "node:fs";

import type { IPCClient } from "../ipc-client/index.ts";
import { hasFlag, shiftFlag } from "../lib/flag-parsing.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { parseWorkflowFileContent } from "../lib/workflow-parse.ts";

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

  // Not just the chunk handler: a workflow step can trip a HITL gate, and the Gateway
  // then blocks on `consent.respond`. With no `consent.request` handler registered
  // here, `nimbus workflow run` hung to the client timeout without ever showing the
  // user a prompt. This is the same helper `nimbus run <file>` uses, so both entry
  // points now prompt identically and both honour NIMBUS_SCRIPT_CONSENT_SOURCE.
  registerInteractiveCliIpcHandlers(client);

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

export async function runWorkflowCli(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const rest = args.slice(1);

  if (sub === "list" || sub === "") {
    await withGatewayIpc((c) => runWorkflowList(c));
    return;
  }
  if (sub === "delete") {
    await withGatewayIpc((c) => runWorkflowDelete(c, rest));
    return;
  }
  if (sub === "save") {
    await withGatewayIpc((c) => runWorkflowSave(c, rest));
    return;
  }
  if (sub === "run") {
    // Only `run` gets the long budget: the Gateway awaits the whole run, and a HITL
    // step waits on the user. `list`/`delete`/`save` are fast RPCs and keep the tight
    // 30s default, which is why this is opt-in per subcommand rather than set on the
    // helper — `requestTimeoutMs` is per-client, so raising it here would slacken the
    // bound for all four.
    await withGatewayIpc((c) => runWorkflowRun(c, rest), undefined, {
      requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
    });
    return;
  }

  throw new Error(
    "Usage: nimbus workflow list | save <name> --file <path> | run <name> | delete <name>",
  );
}
