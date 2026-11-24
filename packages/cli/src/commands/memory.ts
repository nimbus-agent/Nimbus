import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

/**
 * `nimbus memory list [--json]` and `nimbus memory forget <id> | --all` - the owner's view of long-term
 * episodic memory (Phase 10, owner ruling OR-S4-MEM; `[memory] episodic = true` opts in). A memory is a
 * summary a LOCAL model wrote from the owner's own messages and the final answers of one session; it is stored
 * on this machine only. Summary text is model output, so every line is stripped of control characters before
 * it reaches the terminal.
 */
export const MEMORY_USAGE =
  "Usage: nimbus memory list [--json] | nimbus memory forget <id> | --all";

export type MemoryArgs =
  | { readonly mode: "list"; readonly json: boolean }
  | { readonly mode: "forget"; readonly id: string }
  | { readonly mode: "forgetAll" };

export function parseMemoryArgs(argv: readonly string[]): MemoryArgs | undefined {
  const [sub, ...rest] = argv;
  if (sub === "list") {
    if (rest.length === 0) return { mode: "list", json: false };
    if (rest.length === 1 && rest[0] === "--json") return { mode: "list", json: true };
    return undefined;
  }
  if (sub === "forget" && rest.length === 1) {
    const arg = rest[0] as string;
    if (arg === "--all") return { mode: "forgetAll" };
    if (/^mem_[0-9a-f]{16}$/.test(arg)) return { mode: "forget", id: arg };
  }
  return undefined;
}

export interface MemoryIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface MemorySink {
  out(s: string): void;
  err(s: string): void;
}

type MemoryView = {
  id: string;
  sessionId: string;
  summary: string;
  turnCount: number;
  endedAt: number;
  createdAt: number;
  embedded: boolean;
};
type ListReply = {
  enabled: boolean;
  retentionDays: number;
  pendingTurns: number;
  memories: MemoryView[];
};

function printList(r: ListReply, sink: MemorySink): void {
  sink.out(
    `Episodic memory is ${r.enabled ? "ON" : "OFF"} ([memory] episodic in nimbus.toml); retention ${String(r.retentionDays)} days; ${String(r.pendingTurns)} turn(s) waiting to be summarised.\n`,
  );
  if (r.memories.length === 0) {
    sink.out("No memories stored.\n");
    return;
  }
  for (const m of r.memories) {
    const when = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
    sink.out(
      `\n${m.id}  ${when}Z  ${String(m.turnCount)} turn(s)${m.embedded ? "" : "  (not embedded)"}\n`,
    );
    for (const line of m.summary.split(/\r?\n/)) sink.out(`  ${stripControlChars(line)}\n`);
  }
}

export async function runMemoryWith(
  c: MemoryIpc,
  a: MemoryArgs,
  sink: MemorySink,
): Promise<number> {
  try {
    if (a.mode === "list") {
      const r = (await c.call("memory.list", {})) as ListReply;
      if (a.json) sink.out(`${JSON.stringify(r)}\n`);
      else printList(r, sink);
      return 0;
    }
    if (a.mode === "forgetAll") {
      const r = (await c.call("memory.forget", { all: true })) as { forgotten: number };
      sink.out(
        `Forgot ${String(r.forgotten)} memor${r.forgotten === 1 ? "y" : "ies"} and every turn waiting to be summarised.\n`,
      );
      return 0;
    }
    const r = (await c.call("memory.forget", { id: a.id })) as { forgotten: number };
    if (r.forgotten === 0) {
      sink.err(`No memory with id ${a.id}.\n`);
      return 1;
    }
    sink.out(`Forgot ${a.id}.\n`);
    return 0;
  } catch (e) {
    sink.err(`${stripControlChars(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

/** The process-level seams of the command, injectable so the exit-code paths are testable. */
export interface MemoryCommandIo {
  readonly withIpc: (fn: (c: MemoryIpc) => Promise<number>) => Promise<number>;
  readonly sink: MemorySink;
}

const DEFAULT_IO: MemoryCommandIo = {
  withIpc: (fn) => withGatewayIpc(fn, getCliPlatformPaths()),
  sink: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
};

export async function runMemoryCommand(
  args: string[],
  io: MemoryCommandIo = DEFAULT_IO,
): Promise<void> {
  const a = parseMemoryArgs(args);
  if (a === undefined) {
    io.sink.err(`${MEMORY_USAGE}\n`);
    throw new CliExit(2);
  }
  const code = await io.withIpc((c) => runMemoryWith(c, a, io.sink));
  if (code !== 0) throw new CliExit(code);
}
