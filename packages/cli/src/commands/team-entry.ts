// The `nimbus team` entry point: `schedule` (Phase 10, OR-S4-SCHED) is routed here, and `listen` gets
// the scheduling prompt beside the federation consent prompt; every other subcommand is `runTeam`'s.
import { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type RunTeamIo, runTeam, runTeamWithIo, type TeamClient } from "./team.ts";
import { registerScheduleListener, runTeamSchedule } from "./team-schedule.ts";

/** The `IPCClient` surface the listening client wraps (injectable so the wrapper is testable). */
export type ListenInner = Pick<IPCClient, "call" | "connect" | "disconnect" | "onNotification">;

/** A team client that, once connected, declares itself the owner's CLI and answers scheduling prompts. */
export function buildListenClient(
  inner: ListenInner,
  register: (c: ListenInner) => void = (c) => registerScheduleListener(c as IPCClient),
): TeamClient {
  return {
    call: (method, params) => inner.call(method, params),
    onNotification: (method, handler) => inner.onNotification(method, handler),
    disconnect: () => inner.disconnect(),
    connect: async () => {
      await inner.connect();
      await declareCliClientKind(inner);
      register(inner);
    },
  } as TeamClient;
}

export interface TeamEntryDeps {
  readonly schedule: (argv: string[]) => Promise<void>;
  readonly listen: (argv: string[]) => Promise<void>;
  readonly team: (argv: string[]) => Promise<void>;
}

export async function routeTeam(argv: string[], deps: TeamEntryDeps): Promise<void> {
  if (argv[0] === "schedule") return deps.schedule(argv.slice(1));
  if (argv[0] === "listen") return deps.listen(argv);
  return deps.team(argv);
}

/** The I/O `nimbus team listen` runs on: the owner's CLI connection that also answers scheduling prompts. */
export function listenIo(
  readState: RunTeamIo["readGatewayState"] = () => readGatewayState(getCliPlatformPaths()),
  makeInner: (socketPath: string) => ListenInner = (p) => new IPCClient(p),
  exit: RunTeamIo["exit"] = process.exit,
): RunTeamIo {
  return {
    readGatewayState: readState,
    makeClient: (socketPath) => buildListenClient(makeInner(socketPath)),
    exit,
  };
}

function runListen(argv: string[]): Promise<void> {
  return runTeamWithIo(argv, listenIo());
}

export function defaultTeamEntryDeps(): TeamEntryDeps {
  return { schedule: runTeamSchedule, listen: runListen, team: runTeam };
}

export function runTeamEntry(
  argv: string[],
  deps: TeamEntryDeps = defaultTeamEntryDeps(),
): Promise<void> {
  return routeTeam(argv, deps);
}
