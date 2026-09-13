import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { flagValue } from "./_agent-brief-cli.ts";

export type TailCategory = "connector" | "watcher" | "sync" | "extension" | "hitl";

const ALL_CATEGORIES: readonly TailCategory[] = [
  "connector",
  "watcher",
  "sync",
  "extension",
  "hitl",
];

export type TailCliArgs = {
  categories: readonly TailCategory[];
  json: boolean;
};

const USAGE =
  "Usage: nimbus tail [--filter <categories>] [--json]\n" +
  `  --filter   comma-separated, repeatable: ${ALL_CATEGORIES.join(", ")}\n` +
  "  --json     emit raw JSON-RPC notifications as JSONL, one per line\n" +
  "\n" +
  "Streams gateway operational events as they happen. It is follow-only: like `tail -f -n 0`,\n" +
  "it shows what happens from the moment it connects and replays nothing that came before.\n" +
  "Exits on Ctrl+C.";

function isCategory(v: string): v is TailCategory {
  return (ALL_CATEGORIES as readonly string[]).includes(v);
}

export function parseTailArgs(args: string[]): TailCliArgs {
  const picked: TailCategory[] = [];
  let json = false;
  // Distinguishes "no --filter given" (show everything, the documented default) from "--filter
  // given but resolved to zero categories" (e.g. `--filter ,` or `--filter " , "`). Without this,
  // both read as an empty `picked` array and both fell back to ALL_CATEGORIES — a filter that
  // silently matches nothing looked exactly like a healthy, unfiltered stream, the same failure
  // class the unknown-category check below already guards against from the other side.
  let sawFilterFlag = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--filter") {
      sawFilterFlag = true;
      const raw = flagValue(args, i, "--filter");
      for (const part of raw.split(",").map((s) => s.trim())) {
        if (part === "") continue;
        if (!isCategory(part)) {
          throw new Error(
            `Unknown --filter category: ${part}\nValid: ${ALL_CATEGORIES.join(", ")}\n${USAGE}`,
          );
        }
        if (!picked.includes(part)) picked.push(part);
      }
      i += 1;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else {
      throw new Error(`Unexpected argument: ${String(a)}\n${USAGE}`);
    }
  }

  if (sawFilterFlag && picked.length === 0) {
    throw new Error(
      `--filter matched no categories\nValid: ${ALL_CATEGORIES.join(", ")}\n${USAGE}`,
    );
  }

  return { categories: picked.length === 0 ? ALL_CATEGORIES : picked, json };
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : null;
}

function ts(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : new Date().toISOString();
}

/**
 * The category a notification belongs to, or `null` when it is not one of ours — including a
 * future `kind` this build does not recognise. Such an event must still be SHOWN, never dropped,
 * so it deliberately does not map to a category a `--filter` could exclude it by.
 */
function categoryOf(method: string, params: unknown): TailCategory | null {
  if (method === "connector.healthChanged") return "connector";
  if (method !== "gateway.event") return null;
  const o = rec(params);
  const kind = o === null ? null : str(o, "kind");
  if (kind === null) return null;
  if (kind.startsWith("watcher.")) return "watcher";
  if (kind.startsWith("sync.")) return "sync";
  if (kind.startsWith("extension.")) return "extension";
  if (kind.startsWith("hitl.")) return "hitl";
  return null;
}

export function renderEvent(method: string, params: unknown): string | null {
  const o = rec(params);
  if (o === null) return null;

  if (method === "connector.healthChanged") {
    const name = str(o, "name");
    const health = str(o, "health");
    if (name === null || health === null) return null;
    const from = str(o, "fromState") ?? "unknown";
    const reason = str(o, "reason");
    const tail = reason === null ? "" : ` (${reason})`;
    return `${ts(o["occurredAt"])} [connector] ${name}: ${from} -> ${health}${tail}`;
  }

  if (method !== "gateway.event") return null;
  const kind = str(o, "kind");
  if (kind === null) return null;
  const payload = rec(o["payload"]) ?? {};
  const at = ts(o["ts"]);

  if (kind === "sync.completed") {
    const svc = str(payload, "serviceId") ?? "?";
    const up = payload["itemsUpserted"];
    const del = payload["itemsDeleted"];
    const ms = payload["durationMs"];
    return `${at} [sync]      ${svc}: +${String(up)} items, -${String(del)} (${String(ms)}ms)`;
  }
  if (kind === "watcher.fired") {
    return `${at} [watcher]   ${str(payload, "name") ?? "?"}: ${str(payload, "summary") ?? ""}`;
  }
  if (kind === "extension.stateChanged") {
    const ok = payload["ok"] === true;
    const error = str(payload, "error");
    // `ExtensionStateChangedPayload.error` must not be dropped: it's what lets
    // `extension.update`'s ten non-applied outcomes (signature check failed, downgrade refused,
    // an update already in flight, ...) read as anything other than one indistinguishable
    // "(failed)". Omitted cleanly when the field is absent.
    const suffix = ok ? "" : error === null ? " (failed)" : ` (failed: ${error})`;
    return `${at} [extension] ${str(payload, "extensionId") ?? "?"}: ${str(payload, "action") ?? "?"}${suffix}`;
  }
  if (kind === "hitl.requested") {
    return `${at} [hitl]      ${str(payload, "requestId") ?? "?"}: requested — ${str(payload, "prompt") ?? ""}`;
  }
  if (kind === "hitl.resolved") {
    const verdict = payload["approved"] === true ? "approved" : "rejected";
    const reason = str(payload, "reason");
    const suffix = reason === null ? "" : ` — ${reason}`;
    return `${at} [hitl]      ${str(payload, "requestId") ?? "?"}: ${verdict}${suffix}`;
  }

  // Never dropped: a stream that discards what it does not recognise is the same failure as a
  // brief that renders a missing section as empty.
  return `${at} [unknown: ${kind}] ${JSON.stringify(payload)}`;
}

/**
 * The slice of `IPCClient` this command needs. Narrow, matching the real class's own method
 * signatures exactly, so a test double stays small and honest (the same shape as `computer.ts`'s
 * `ComputerClient`) while a real `IPCClient` instance is still assignable to it with no wrapping.
 */
export interface TailClient {
  onNotification(method: string, handler: (params: unknown) => void): void;
  onClose(handler: (err: Error) => void): void;
  disconnect(): Promise<void>;
}

/**
 * Every side effect is injectable, so the command's LIFECYCLE is testable and not just its two
 * pure functions. Without these seams the gateway-offline path, the filter predicate, the
 * shutdown path and the EPIPE guard are all unreachable from a unit test — which is how a command
 * ends up with green tests and an untested main path.
 */
export type TailCommandDeps = {
  readonly connect: (socketPath: string) => Promise<TailClient>;
  readonly readState: () => Promise<{ socketPath: string } | undefined>;
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
  readonly onExit: (code: number) => void;
};

const defaultTailDeps: TailCommandDeps = {
  connect: async (socketPath) => {
    const client = new IPCClient(socketPath);
    await client.connect();
    return client;
  },
  readState: async () => await readGatewayState(getCliPlatformPaths()),
  writeOut: (line) => {
    process.stdout.write(line);
  },
  writeErr: (line) => {
    process.stderr.write(line);
  },
  onExit: (code) => {
    process.exit(code);
  },
};

export async function runTailCommand(
  args: string[],
  deps: TailCommandDeps = defaultTailDeps,
): Promise<void> {
  const parsed = parseTailArgs(args);

  const state = await deps.readState();

  if (state === undefined) {
    deps.writeErr("Gateway is not running. Start with: nimbus start\n");
    deps.onExit(1);
    return;
  }

  // Piping into e.g. `head -n 5` closes stdout early. Without this the process dies with an
  // unhandled EPIPE stack trace, which is the first thing anyone does with a stream.
  const onStdoutError = (e: NodeJS.ErrnoException): void => {
    if (e.code === "EPIPE") deps.onExit(0);
  };
  process.stdout.on("error", onStdoutError);

  const client = await deps.connect(state.socketPath);

  const onEvent =
    (method: string) =>
    (params: unknown): void => {
      const category = categoryOf(method, params);
      // An UNCATEGORISED event (a future `kind`) is shown even under a filter. A stream that
      // silently drops what it does not recognise is the failure this design rejects; the cost is
      // that `--filter sync` may show one unfamiliar line, which is strictly better than hiding a
      // new event type from everyone who uses a filter.
      if (category !== null && !parsed.categories.includes(category)) return;
      if (parsed.json) {
        deps.writeOut(`${JSON.stringify({ method, params })}\n`);
        return;
      }
      const line = renderEvent(method, params);
      if (line !== null) deps.writeOut(`${line}\n`);
    };

  // EXACTLY TWO handlers, forever. A future operational event picks a new `kind` and arrives here
  // with no CLI change — which is why the envelope exists.
  client.onNotification("connector.healthChanged", onEvent("connector.healthChanged"));
  client.onNotification("gateway.event", onEvent("gateway.event"));

  await new Promise<void>((resolve) => {
    // Listeners are REMOVED on every exit path. `process` outlives this promise, so leaving them
    // attached leaks one handler per invocation — invisible for a one-shot CLI, a real leak for
    // any caller that runs the command twice in a process (tests included).
    function shutdown(): void {
      void client.disconnect().finally(() => finish(0));
    }
    function finish(code: number): void {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.stdout.off("error", onStdoutError);
      process.exitCode = code;
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    client.onClose(() => {
      deps.writeErr("[nimbus tail] Gateway connection closed.\n");
      finish(1);
    });
  });
}
