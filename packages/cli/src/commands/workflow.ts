import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";

import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
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
    throw new Error(WORKFLOW_SAVE_USAGE);
  }
  const description = shiftFlag(tail, "--description");
  const schedule = shiftFlag(tail, "--schedule");
  const tz = shiftFlag(tail, "--tz");
  if (tz !== undefined && schedule === undefined) {
    throw new Error("--tz needs --schedule");
  }
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
  if (schedule !== undefined) {
    // A schedule is set only by the owner's CLI: the gateway refuses it from any connection that has
    // not declared the `cli` kind (SA4). Best-effort declaration, like `nimbus workflow run`.
    await declareCliClientKind(client);
    savePayload["schedule"] = schedule;
    if (tz !== undefined) savePayload["scheduleTz"] = tz;
  }
  const out = await client.call("workflow.save", savePayload);
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runWorkflowUnschedule(client: IPCClient, rest: string[]): Promise<void> {
  const name = rest[0]?.trim() ?? "";
  if (name === "") {
    throw new Error("Usage: nimbus workflow unschedule <name>");
  }
  const out = await client.call<{ ok: boolean }>("workflow.unschedule", { name });
  console.log(JSON.stringify(out, undefined, 2));
}

export const WORKFLOW_SAVE_USAGE =
  'Usage: nimbus workflow save <name> --file <path> [--description text] [--schedule "<cron>" [--tz <IANA zone>]]';

export const WORKFLOW_RESUME_USAGE = "Usage: nimbus workflow resume <runId> [--discard]";

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

  // The run's write steps carry the owner's provenance only when the gateway knows this connection
  // is the owner's CLI (Phase 10 SA2/SA3); best-effort, like `nimbus ask`.
  await declareCliClientKind(client);

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

/**
 * `nimbus workflow resume <runId> [--discard]` (SA4): run a workflow that stopped at a write step no
 * standing rule covered, now with the normal prompt on this terminal. `--discard` abandons the
 * blocked run so scheduling continues. The gateway refuses a connection that is not the owner's CLI.
 */
export async function runWorkflowResume(client: IPCClient, rest: string[]): Promise<void> {
  const tail = [...rest];
  const discard = hasFlag(tail, "--discard");
  const runId = tail.find((a) => !a.startsWith("--"))?.trim() ?? "";
  if (runId === "") throw new Error(WORKFLOW_RESUME_USAGE);
  // The prompt of a resumed write step reaches this terminal, exactly as `workflow run`'s does.
  registerInteractiveCliIpcHandlers(client);
  await declareCliClientKind(client);
  const out = await client.call("workflow.resume", {
    runId,
    ...(discard ? { discard: true } : {}),
  });
  console.log(`
${JSON.stringify(out, undefined, 2)}`);
}

export const WORKFLOW_EXPORT_USAGE =
  "Usage: nimbus workflow export <name> --out <file> [--author <label>] [--force]";

export const WORKFLOW_IMPORT_USAGE =
  'Usage: nimbus workflow import <file> [--replace] [--accept-signer-change] [--signer <fingerprint>] [--schedule "<cron>" [--tz <IANA zone>]] [--dry-run]';

/** The message `import` gives for `--yes`: a workflow from outside is approved by a person. */
export const WORKFLOW_IMPORT_YES_REFUSAL =
  "nimbus workflow import cannot take --yes: a workflow bundle is approved by you, at the prompt, over its exact text, never automatically.";

/** A bundle is at most 256 KiB; refuse a far larger file before reading it. */
const IMPORT_FILE_MAX_BYTES = 1024 * 1024;

/**
 * `nimbus workflow export <name> --out <file> [--author <label>] [--force]` (I59): the gateway signs the
 * saved workflow with the share key (a bundle holds deterministic query and write steps only, no
 * schedule, rule or credential) and this command writes the file, refusing to overwrite without `--force`.
 */
export async function runWorkflowExport(client: IPCClient, rest: string[]): Promise<void> {
  const tail = [...rest];
  const out = shiftRequiredValue(tail, "--out");
  const author = shiftRequiredValue(tail, "--author");
  const force = hasFlag(tail, "--force");
  const name = tail.find((a) => !a.startsWith("--"))?.trim() ?? "";
  if (name === "" || out === undefined || out === "") throw new Error(WORKFLOW_EXPORT_USAGE);
  await declareCliClientKind(client);
  const res = await client.call<{
    bundle: string;
    fingerprint: string;
    stepsSha256: string;
    issuedAt: number;
  }>("workflow.export", { name, ...(author === undefined ? {} : { author }) });
  try {
    // `wx` refuses to replace an existing file; `--force` opts in.
    writeFileSync(out, res.bundle, { encoding: "utf8", flag: force ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${out} already exists; pass --force to overwrite it`);
    }
    throw e;
  }
  console.log(
    `Wrote ${out}
Signer fingerprint: ${res.fingerprint}
Content hash: ${res.stepsSha256}
Share the fingerprint with your team through another channel: an importer compares it before approving.`,
  );
}

/**
 * A value-taking option that was supplied must carry a value: a trailing `--signer` (or one followed by
 * another option) is an error, never a silent omission of the pin it asked for. An absent option stays
 * `undefined`.
 */
function shiftRequiredValue(tail: string[], flag: string): string | undefined {
  const i = tail.indexOf(flag);
  if (i < 0) return undefined;
  const v = tail[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  tail.splice(i, 2);
  return v;
}

/**
 * `nimbus workflow import <file> ...` (I59): reads the bundle and asks the gateway, which verifies the
 * signature, shows the exact steps at a prompt on this terminal and writes only after you answer it as a
 * person. `--yes` is refused here and, whatever a client sends, at the gateway.
 */
export async function runWorkflowImport(client: IPCClient, rest: string[]): Promise<void> {
  const tail = [...rest];
  if (tail.includes("--yes") || tail.includes("-y")) throw new Error(WORKFLOW_IMPORT_YES_REFUSAL);
  const replace = hasFlag(tail, "--replace");
  const acceptSignerChange = hasFlag(tail, "--accept-signer-change");
  const dryRun = hasFlag(tail, "--dry-run");
  const signer = shiftRequiredValue(tail, "--signer");
  const schedule = shiftRequiredValue(tail, "--schedule");
  const tz = shiftRequiredValue(tail, "--tz");
  if (tz !== undefined && schedule === undefined) throw new Error("--tz needs --schedule");
  const file = tail.find((a) => !a.startsWith("--"))?.trim() ?? "";
  if (file === "") throw new Error(WORKFLOW_IMPORT_USAGE);
  // One descriptor for the size check and the read, so the file cannot change between them.
  const fd = openSync(file, "r");
  let bundle: string;
  try {
    if (fstatSync(fd).size > IMPORT_FILE_MAX_BYTES) {
      throw new Error("the bundle file is far larger than a workflow bundle can be (256 KiB)");
    }
    bundle = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  // The approval prompt reaches this terminal, exactly as `workflow run`'s does.
  registerInteractiveCliIpcHandlers(client);
  // The gateway imports only for a connection that declared the owner's CLI.
  await declareCliClientKind(client);
  const res = await client.call<{ promptText?: string }>("workflow.import", {
    bundle,
    ...(replace ? { replace: true } : {}),
    ...(acceptSignerChange ? { acceptSignerChange: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(signer === undefined ? {} : { signer }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(tz === undefined ? {} : { scheduleTz: tz }),
  });
  if (dryRun && typeof res.promptText === "string") {
    console.log(`${res.promptText}

(dry run: nothing was written and nobody was asked)`);
    return;
  }
  console.log(JSON.stringify(res, undefined, 2));
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
  if (sub === "export") {
    await withGatewayIpc((c) => runWorkflowExport(c, rest));
    return;
  }
  if (sub === "import") {
    await withGatewayIpc((c) => runWorkflowImport(c, rest), undefined, {
      requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
    });
    return;
  }
  if (sub === "unschedule") {
    await withGatewayIpc((c) => runWorkflowUnschedule(c, rest));
    return;
  }
  if (sub === "resume") {
    await withGatewayIpc((c) => runWorkflowResume(c, rest), undefined, {
      requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
    });
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
    "Usage: nimbus workflow list | save <name> --file <path> [--schedule <cron>] | export <name> --out <file> | import <file> | unschedule <name> | run <name> | resume <runId> [--discard] | delete <name>",
  );
}
