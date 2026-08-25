import { REAL_GATEWAY_CLI_IO, runGatewayCliCommand } from "../lib/run-gateway-cli-command.ts";

export type TribalCommand =
  | { kind: "status" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "list"; status?: string }
  | { kind: "dismiss"; clusterId: string }
  | { kind: "scan" }
  | { kind: "capture"; clusterId: string; target?: "notion" | "confluence" };

/** Minimal client surface used by the tribal dispatcher — satisfied by IPCClient. */
export interface TribalIpc {
  call<T>(method: string, params?: unknown): Promise<T>;
}

interface TribalStatusResult {
  readonly enabled: boolean;
  readonly clusters: number;
}

interface TribalClusterRow {
  readonly clusterId: string;
  readonly representativeQuestion: string;
  readonly occurrenceCount: number;
  readonly status: string;
  readonly channelId: string;
}

const USAGE =
  "Usage: nimbus tribal [status|start|stop|list [status]|dismiss <cluster-id>|scan|capture <cluster-id> [--target notion|confluence]]";

function parseCaptureArgs(rest: string[]): TribalCommand {
  let clusterId: string | undefined;
  let target: "notion" | "confluence" | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--target") {
      const v = rest[i + 1];
      if (v !== "notion" && v !== "confluence") {
        throw new Error("nimbus tribal capture --target must be 'notion' or 'confluence'");
      }
      target = v;
      i++;
    } else if (a !== undefined && !a.startsWith("--")) {
      if (clusterId !== undefined) {
        throw new Error("nimbus tribal capture takes a single <cluster-id>");
      }
      clusterId = a;
    } else if (a !== undefined) {
      throw new Error(`Unknown option for capture: ${a}`);
    }
  }
  if (clusterId === undefined || clusterId === "") {
    throw new Error("Usage: nimbus tribal capture <cluster-id> [--target notion|confluence]");
  }
  return target === undefined
    ? { kind: "capture", clusterId }
    : { kind: "capture", clusterId, target };
}

export function parseTribalArgs(argv: string[]): TribalCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "status":
      return { kind: "status" };
    case "start":
      return { kind: "start" };
    case "stop":
      return { kind: "stop" };
    case "list": {
      const status = rest[0]?.trim();
      return status === undefined || status === "" ? { kind: "list" } : { kind: "list", status };
    }
    case "dismiss": {
      const clusterId = rest[0]?.trim();
      if (clusterId === undefined || clusterId === "") {
        throw new Error("Usage: nimbus tribal dismiss <cluster-id>");
      }
      return { kind: "dismiss", clusterId };
    }
    case "scan":
      return { kind: "scan" };
    case "capture":
      return parseCaptureArgs(rest);
    default:
      throw new Error(`Unknown subcommand: ${sub}\n${USAGE}`);
  }
}

/** Execute a parsed tribal subcommand over an injected client (test entry point + runtime path). */
export async function runTribalCommand(client: TribalIpc, cmd: TribalCommand): Promise<void> {
  switch (cmd.kind) {
    case "status": {
      const r = await client.call<TribalStatusResult>("tribal.status", {});
      process.stdout.write(
        `Tribal-knowledge watcher ${r.enabled ? "enabled" : "disabled"} (${r.clusters} cluster${r.clusters === 1 ? "" : "s"})\n`,
      );
      break;
    }
    case "start": {
      await client.call("tribal.start", {});
      process.stdout.write("Tribal watcher started\n");
      break;
    }
    case "stop": {
      await client.call("tribal.stop", {});
      process.stdout.write("Tribal watcher stopped\n");
      break;
    }
    case "list": {
      await runTribalList(client, cmd.status);
      break;
    }
    case "dismiss": {
      await client.call("tribal.dismiss", { clusterId: cmd.clusterId });
      process.stdout.write(`Dismissed ${cmd.clusterId}\n`);
      break;
    }
    case "scan": {
      const r = await client.call<{ scanned: number; fired: number }>("tribal.scan", {});
      process.stdout.write(`Scanned ${r.scanned}; ${r.fired} suggestion(s) fired\n`);
      break;
    }
    case "capture": {
      await runTribalCapture(client, cmd.clusterId, cmd.target);
      break;
    }
  }
}

/** `tribal list [--status]`: print each cluster row, or a placeholder when empty. */
async function runTribalList(client: TribalIpc, status: string | undefined): Promise<void> {
  const rows = await client.call<TribalClusterRow[]>(
    "tribal.list",
    status === undefined ? {} : { status },
  );
  if (rows.length === 0) {
    process.stdout.write("No clusters.\n");
    return;
  }
  for (const c of rows) {
    process.stdout.write(
      `  ${c.clusterId} [${c.status}] ×${c.occurrenceCount} (${c.channelId}) — ${c.representativeQuestion}\n`,
    );
  }
}

/** `tribal capture <id> [--target]`: run the owner-HITL capture and report the outcome. */
async function runTribalCapture(
  client: TribalIpc,
  clusterId: string,
  target: "notion" | "confluence" | undefined,
): Promise<void> {
  const r = await client.call<{ ok: boolean; pageRef?: string; error?: string }>(
    "tribal.capture",
    target === undefined ? { clusterId } : { clusterId, target },
  );
  if (r.ok) {
    process.stdout.write(`Captured ${clusterId} → ${r.pageRef ?? "(no ref)"}\n`);
  } else {
    process.stderr.write(`Capture failed: ${r.error ?? "unknown"}\n`);
    process.exitCode = 1;
  }
}

export async function runTribal(argv: string[]): Promise<void> {
  await runGatewayCliCommand(argv, {
    parse: parseTribalArgs,
    dispatch: runTribalCommand,
    io: REAL_GATEWAY_CLI_IO,
  });
}
