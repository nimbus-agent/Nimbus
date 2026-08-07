import type { IPCClient } from "../ipc-client/index.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type OwnersCliArgs = {
  path: string | undefined;
  service: string | undefined;
  json: boolean;
  refresh: boolean;
};

const USAGE =
  "Usage: nimbus owners [<path>] [--service <name>] [--json] [--refresh]\n" +
  "  <path>       a file or directory inside a configured git-aware root\n" +
  "  --service    a [ci.service.<id>] service id\n" +
  "  (no args)    ownership coverage summary";

/**
 * `nimbus owners` hard-rejects an unrecognised flag rather than ignoring it, matching
 * `nimbus glossary`. Silently dropping `--srevice` would return a whole-repo summary that
 * looks like a successful answer to a question nobody asked.
 */
export function parseOwnersArgs(args: string[]): OwnersCliArgs {
  let path: string | undefined;
  let service: string | undefined;
  let json = false;
  let refresh = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") {
      json = true;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--service") {
      service = flagValue(args, i, "--service");
      i++;
    } else if (a.startsWith("--")) {
      throw new Error(`Unrecognised flag: ${a}\n${USAGE}`);
    } else if (path === undefined) {
      path = a;
    } else {
      throw new Error(`Unexpected argument: ${a}\n${USAGE}`);
    }
  }

  if (path !== undefined && service !== undefined) {
    throw new Error(`<path> and --service are mutually exclusive\n${USAGE}`);
  }
  return { path, service, json, refresh };
}

type OwnershipBriefLike = { kind: "ownership"; gaps: unknown[] };

function isOwnershipBriefLike(x: unknown): x is OwnershipBriefLike {
  if (x === null || typeof x !== "object") return false;
  const b = x as { kind?: unknown; gaps?: unknown };
  return b.kind === "ownership" && Array.isArray(b.gaps);
}

function awaitPass(client: IPCClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const teardown = (): void => {
      client.offNotification("ownership.passDone", onDone);
      client.offNotification("ownership.passError", onError);
      client.offClose(onClose);
    };
    function onDone(): void {
      teardown();
      resolve();
    }
    function onError(n: unknown): void {
      teardown();
      reject(new Error((n as { message?: string }).message ?? "ownership pass failed"));
    }
    // A pass runs unbounded, so a gateway that dies mid-pass must be detected explicitly
    // rather than hanging forever — the same reason decisions' awaitPass binds onClose.
    function onClose(err: Error): void {
      teardown();
      reject(new Error(`gateway connection closed during the pass: ${err.message}`));
    }
    client.onNotification("ownership.passDone", onDone);
    client.onNotification("ownership.passError", onError);
    client.onClose(onClose);
    client.call<{ jobId: string }>("ownership.refresh", {}).catch((err: unknown) => {
      teardown();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Testability seam mirroring `DecisionsCommandDeps` — no `mock.module`. */
export type OwnersCommandDeps = {
  runAgentBriefCli: typeof runAgentBriefCli;
};

const defaultOwnersDeps: OwnersCommandDeps = { runAgentBriefCli };

export async function runOwnersCommand(
  args: string[],
  deps: OwnersCommandDeps = defaultOwnersDeps,
): Promise<void> {
  const parsed = parseOwnersArgs(args);

  await deps.runAgentBriefCli<OwnershipBriefLike>({
    kind: "ownership",
    guard: isOwnershipBriefLike,
    json: parsed.json,
    params: {
      ...(parsed.path === undefined ? {} : { path: parsed.path }),
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
    },
    ...(parsed.refresh
      ? {
          beforeCall: async (client: IPCClient) => {
            await awaitPass(client);
          },
        }
      : {}),
  });
}
