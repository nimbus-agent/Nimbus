import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type TribalCommand =
  | { kind: "status" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "list"; status?: string }
  | { kind: "dismiss"; clusterId: string }
  | { kind: "scan" };

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

const USAGE = "Usage: nimbus tribal [status|start|stop|list [status]|dismiss <cluster-id>|scan]";

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
      const rows = await client.call<TribalClusterRow[]>(
        "tribal.list",
        cmd.status === undefined ? {} : { status: cmd.status },
      );
      if (rows.length === 0) {
        process.stdout.write("No clusters.\n");
        break;
      }
      for (const c of rows) {
        process.stdout.write(
          `  ${c.clusterId} [${c.status}] ×${c.occurrenceCount} (${c.channelId}) — ${c.representativeQuestion}\n`,
        );
      }
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
  }
}

export async function runTribal(argv: string[]): Promise<void> {
  let cmd: TribalCommand;
  try {
    cmd = parseTribalArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    await runTribalCommand(client, cmd);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
