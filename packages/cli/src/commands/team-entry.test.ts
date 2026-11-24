import { expect, test } from "bun:test";
import {
  buildListenClient,
  defaultTeamEntryDeps,
  type ListenInner,
  listenIo,
  routeTeam,
  runTeamEntry,
} from "./team-entry.ts";

test("schedule is routed without its verb; listen and everything else keep theirs", async () => {
  const seen: string[] = [];
  const deps = {
    schedule: async (a: string[]) => void seen.push(`schedule:${a.join(" ")}`),
    listen: async (a: string[]) => void seen.push(`listen:${a.join(" ")}`),
    team: async (a: string[]) => void seen.push(`team:${a.join(" ")}`),
  };
  await routeTeam(["schedule", "peer:aa", "--from", "now"], deps);
  await routeTeam(["listen"], deps);
  await routeTeam(["pair", "h", "c"], deps);
  await routeTeam([], deps);
  expect(seen).toEqual(["schedule:peer:aa --from now", "listen:listen", "team:pair h c", "team:"]);
});

test("a listening client declares the CLI kind and registers the prompt after connecting", async () => {
  const order: string[] = [];
  const inner: ListenInner = {
    call: async (m: string) => {
      order.push(`call:${m}`);
      return {};
    },
    connect: async () => void order.push("connect"),
    disconnect: async () => void order.push("disconnect"),
    onNotification: () => void order.push("on"),
  } as unknown as ListenInner;
  const c = buildListenClient(inner, () => order.push("register"));
  await c.connect();
  await c.call("x");
  c.onNotification("m", () => {});
  await c.disconnect();
  expect(order).toEqual([
    "connect",
    "call:session.declareKind",
    "register",
    "call:x",
    "on",
    "disconnect",
  ]);
});

test("listenIo wraps whatever connection it is given and passes the other seams through", async () => {
  const exits: number[] = [];
  const made: string[] = [];
  const io = listenIo(
    async () => undefined,
    (p) => {
      made.push(p);
      return {
        call: async () => ({}),
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      } as unknown as ListenInner;
    },
    ((c: number) => void exits.push(c)) as never,
  );
  expect(await io.readGatewayState()).toBeUndefined();
  io.makeClient("/tmp/sock");
  io.exit(3);
  expect(made).toEqual(["/tmp/sock"]);
  expect(exits).toEqual([3]);
});

test("the default deps route all three verbs, and runTeamEntry uses the ones it is given", async () => {
  const d = defaultTeamEntryDeps();
  expect(Object.keys(d).sort()).toEqual(["listen", "schedule", "team"]);
  const seen: string[] = [];
  await runTeamEntry(["schedule", "x"], {
    schedule: async (a) => void seen.push(a.join(",")),
    listen: async () => {},
    team: async () => {},
  });
  expect(seen).toEqual(["x"]);
});

test("the real seams build without connecting: a wrapped client and a state read", async () => {
  const io = listenIo();
  const c = io.makeClient("\\.pipe\nimbus-test-never-connected");
  expect(typeof c.connect).toBe("function");
  // A read of the CLI's own state file: it is absent or names a gateway; neither is acted on here.
  await io.readGatewayState();
  const d = defaultTeamEntryDeps();
  expect(d.listen.length).toBe(1);
});
