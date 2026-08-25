import { REAL_GATEWAY_CLI_IO, runGatewayCliCommand } from "../lib/run-gateway-cli-command.ts";

export type ChatopsCommand =
  | { kind: "status" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "test"; text: string };

/** Minimal client surface used by the chatops dispatcher — satisfied by IPCClient. */
export interface ChatopsIpc {
  call<T>(method: string, params?: unknown): Promise<T>;
}

interface ChatopsPlatformStatus {
  readonly name: string;
  readonly connected: boolean;
  readonly channels: number;
}
interface ChatopsStatusResult {
  readonly enabled: boolean;
  readonly platforms: readonly ChatopsPlatformStatus[];
  readonly lastEventAt?: number;
}

export function parseChatopsArgs(argv: string[]): ChatopsCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "status":
      return { kind: "status" };
    case "start":
      return { kind: "start" };
    case "stop":
      return { kind: "stop" };
    case "test": {
      const text = rest.join(" ").trim();
      if (text === "") throw new Error('Usage: nimbus chatops test "<message>"');
      return { kind: "test", text };
    }
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus chatops [status|start|stop|test "<message>"]`,
      );
  }
}

/** Execute a parsed chatops subcommand over an injected client (test entry point + runtime path). */
export async function runChatopsCommand(client: ChatopsIpc, cmd: ChatopsCommand): Promise<void> {
  switch (cmd.kind) {
    case "status": {
      const r = await client.call<ChatopsStatusResult>("chatops.status", {});
      process.stdout.write(`ChatOps ${r.enabled ? "enabled" : "disabled"}\n`);
      for (const p of r.platforms) {
        process.stdout.write(
          `  ${p.name}: ${p.connected ? "connected" : "disconnected"} (${p.channels} channel${p.channels === 1 ? "" : "s"})\n`,
        );
      }
      break;
    }
    case "start": {
      await client.call("chatops.start", {});
      process.stdout.write("ChatOps started\n");
      break;
    }
    case "stop": {
      await client.call("chatops.stop", {});
      process.stdout.write("ChatOps stopped\n");
      break;
    }
    case "test": {
      const r = await client.call<unknown>("chatops.test", { text: cmd.text });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
  }
}

export async function runChatops(argv: string[]): Promise<void> {
  await runGatewayCliCommand(argv, {
    parse: parseChatopsArgs,
    dispatch: runChatopsCommand,
    io: REAL_GATEWAY_CLI_IO,
  });
}
