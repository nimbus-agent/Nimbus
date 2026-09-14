import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { formatExplain, parseExplainLastResult } from "./explain-format.ts";

const USAGE = "usage: nimbus explain last [--json]";

/** Registered in COMMAND_HANDLERS; matches the `(args: string[])` CommandHandler signature. */
export async function runExplainCmd(args: string[]): Promise<void> {
  await withGatewayIpc((c) => runExplain(c, args));
}

/** The client-taking implementation, exported separately so unit tests need no live gateway. */
export async function runExplain(client: IPCClient, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "last") {
    throw new Error(USAGE);
  }

  // The IPC response is external data: `call<unknown>` plus a real narrowing pass, never a bare
  // cast — a malformed or version-skewed Gateway response fails loudly here instead of silently
  // corrupting the report this feature exists to make trustworthy.
  const raw = await client.call<unknown>("ask.explainLast", null);
  const res = parseExplainLastResult(raw);

  if (args.includes("--json")) {
    console.log(JSON.stringify(res, undefined, 2));
    return;
  }

  if (res.record === null) {
    // The ring is in memory only. Saying "no ask recorded since the gateway started" is a
    // different and honest claim; printing an empty report would imply no ask ever happened.
    process.stdout.write("No ask recorded since the gateway started.\n");
    return;
  }

  const noColorEnv = process.env["NO_COLOR"];
  const noColor = (noColorEnv !== undefined && noColorEnv !== "") || process.stdout.isTTY !== true;
  process.stdout.write(formatExplain(res.record, { noColor }));
}
