import { describe, expect, test } from "bun:test";

import {
  type PostInstallIo,
  parseFixCommand,
  runConnectFix,
  runPostInstallWalk,
} from "./extension-post-install.ts";
import type { RequirementStatusView } from "./extension-requirements-format.ts";

type Event =
  | { kind: "confirm"; question: string }
  | { kind: "approve"; id: string }
  | { kind: "connect"; connector: string; approved: string[] }
  | { kind: "log"; line: string };

function fakeIo(
  opts: {
    attended?: boolean;
    answer?: boolean;
    failApprove?: ReadonlySet<string>;
    connect?: PostInstallIo["connect"];
  } = {},
): { io: PostInstallIo; events: Event[] } {
  const events: Event[] = [];
  const io: PostInstallIo = {
    attended: opts.attended ?? true,
    confirm: async (question) => {
      events.push({ kind: "confirm", question });
      return opts.answer ?? true;
    },
    approve: async (id) => {
      events.push({ kind: "approve", id });
      if (opts.failApprove?.has(id) === true) throw new Error("consent denied");
    },
    connect:
      opts.connect ??
      (async (req, approved) => {
        events.push({ kind: "connect", connector: req.connector, approved: [...approved].sort() });
      }),
    log: (line) => {
      events.push({ kind: "log", line });
    },
  };
  return { io, events };
}

const bundled = (
  connector: string,
  interactive: boolean,
  state: RequirementStatusView["state"] = "not_connected",
): RequirementStatusView => ({
  connector,
  state,
  owner: { kind: "bundled" },
  fix: [`nimbus connector auth ${connector}`],
  interactive,
  requiredBy: [],
});

describe("runPostInstallWalk", () => {
  test("unattended does nothing", async () => {
    const { io, events } = fakeIo({ attended: false });
    await runPostInstallWalk(io, ["dep.a", "root"], [bundled("github", true)]);
    expect(events).toEqual([]);
  });

  test("approves every package in order without a walk question of its own", async () => {
    const { io, events } = fakeIo();
    await runPostInstallWalk(io, ["dep.a", "dep.b", "root"], []);
    expect(events.filter((e) => e.kind === "approve").map((e) => e.id)).toEqual([
      "dep.a",
      "dep.b",
      "root",
    ]);
    expect(events.some((e) => e.kind === "confirm")).toBe(false);
    expect(events[0]).toEqual({
      kind: "log",
      line: "Approve each package to run (you can decline any):",
    });
  });

  test("a declined approval does not stop the walk", async () => {
    const { io, events } = fakeIo({ failApprove: new Set(["dep.b"]) });
    await runPostInstallWalk(io, ["dep.a", "dep.b", "root"], [bundled("github", true)]);
    expect(events.filter((e) => e.kind === "approve").map((e) => e.id)).toEqual([
      "dep.a",
      "dep.b",
      "root",
    ]);
    expect(events).toContainEqual({ kind: "log", line: "  dep.b: not approved (consent denied)" });
    expect(events).toContainEqual({
      kind: "connect",
      connector: "github",
      approved: ["dep.a", "root"],
    });
  });

  test("offers to connect only interactive not_connected requirements, after approvals", async () => {
    const { io, events } = fakeIo();
    await runPostInstallWalk(
      io,
      ["root"],
      [
        bundled("github", true),
        bundled("slack", false),
        bundled("jira", true, "met"),
        bundled("linear", true, "configured_never_synced"),
      ],
    );
    expect(events).toEqual([
      { kind: "log", line: "Approve each package to run (you can decline any):" },
      { kind: "approve", id: "root" },
      { kind: "confirm", question: "This needs github. Connect now? [y/N] " },
      { kind: "connect", connector: "github", approved: ["root"] },
      { kind: "log", line: "  slack: connect it with: nimbus connector auth slack" },
    ]);
  });

  test("a no to the connect question connects nothing", async () => {
    const { io, events } = fakeIo({ answer: false });
    await runPostInstallWalk(io, ["root"], [bundled("github", true)]);
    expect(events.some((e) => e.kind === "connect")).toBe(false);
  });

  test("a throwing connect is logged and the walk continues", async () => {
    const seen: string[] = [];
    const { io, events } = fakeIo({
      connect: async (req) => {
        seen.push(req.connector);
        if (req.connector === "github") throw new Error("auth failed");
      },
    });
    await runPostInstallWalk(io, ["root"], [bundled("github", true), bundled("gitlab", true)]);
    expect(seen).toEqual(["github", "gitlab"]);
    expect(events).toContainEqual({ kind: "log", line: "  github: not connected (auth failed)" });
  });

  test("connect skips an approve the walk already did", async () => {
    const runs: string[] = [];
    const runners = {
      connectorAuth: async (id: string) => {
        runs.push(`auth ${id}`);
      },
      approve: async (id: string) => {
        runs.push(`approve ${id}`);
      },
      credentialSet: async (ext: string, name: string) => {
        runs.push(`credential ${ext} ${name}`);
      },
      log: (line: string) => {
        runs.push(`log ${line}`);
      },
    };
    const owned: RequirementStatusView = {
      connector: "readwise",
      state: "not_connected",
      owner: { kind: "extension", extensionId: "nimbus.readwise" },
      fix: [
        "nimbus extension approve nimbus.readwise",
        "nimbus extension credential set nimbus.readwise api_token",
      ],
      interactive: true,
      requiredBy: [],
    };
    const { io } = fakeIo({ connect: (req, approved) => runConnectFix(req, approved, runners) });
    await runPostInstallWalk(io, ["nimbus.readwise"], [owned]);
    expect(runs).toEqual(["credential nimbus.readwise api_token"]);

    // Not yet approved: the fix's approve runs first, then the credential.
    runs.length = 0;
    await runConnectFix(owned, new Set(), runners);
    expect(runs).toEqual(["approve nimbus.readwise", "credential nimbus.readwise api_token"]);
  });

  test("an unrecognised fix command is logged, never run", async () => {
    const runs: string[] = [];
    await runConnectFix(
      { ...bundled("github", true), fix: ["rm -rf / && nimbus connector auth github"] },
      new Set(),
      {
        connectorAuth: async (id) => {
          runs.push(`auth ${id}`);
        },
        approve: async () => {},
        credentialSet: async () => {},
        log: (line) => {
          runs.push(line);
        },
      },
    );
    expect(runs).toEqual(["  not run (run it yourself): rm -rf / && nimbus connector auth github"]);
  });
});

describe("parseFixCommand", () => {
  test("parses the three fixed prefixes", () => {
    expect(parseFixCommand("nimbus connector auth google-drive")).toEqual({
      kind: "connector-auth",
      id: "google-drive",
    });
    expect(parseFixCommand("nimbus extension approve a.b")).toEqual({
      kind: "approve",
      extensionId: "a.b",
    });
    expect(parseFixCommand("nimbus extension credential set a.b token")).toEqual({
      kind: "credential-set",
      extensionId: "a.b",
      name: "token",
    });
  });

  test("anything else is undefined", () => {
    for (const c of [
      "nimbus connector sync github",
      "nimbus connector auth github --token x",
      "nimbus extension approve a.b --model",
      "sh -c nimbus",
      "",
    ]) {
      expect(parseFixCommand(c)).toBeUndefined();
    }
  });
});
