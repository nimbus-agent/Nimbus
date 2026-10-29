import { describe, expect, test } from "bun:test";

import {
  type PostInstallIo,
  parseFixCommand,
  RUN_NOT_APPROVED_CODE,
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
    /** One answer for every question, or one per question. */
    answer?: boolean | ((question: string) => boolean);
    /** The owner answers no to these packages' `extension.run` prompts. */
    failApprove?: ReadonlySet<string>;
    /** These packages' approvals cannot be asked at all (a transport failure). */
    brokenApprove?: ReadonlySet<string>;
    connect?: PostInstallIo["connect"];
  } = {},
): { io: PostInstallIo; events: Event[] } {
  const events: Event[] = [];
  const io: PostInstallIo = {
    attended: opts.attended ?? true,
    confirm: async (question) => {
      events.push({ kind: "confirm", question });
      const a = opts.answer ?? true;
      return typeof a === "function" ? a(question) : a;
    },
    approve: async (id) => {
      events.push({ kind: "approve", id });
      if (opts.failApprove?.has(id) === true) {
        throw new Error(`${RUN_NOT_APPROVED_CODE}: running ${id} was not approved`);
      }
      if (opts.brokenApprove?.has(id) === true) throw new Error("socket gone");
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

  test("asks once first, then a yes approves every package in order", async () => {
    const { io, events } = fakeIo();
    await runPostInstallWalk(io, ["dep.a", "dep.b", "root"], []);
    expect(events).toEqual([
      { kind: "confirm", question: "Approve the 3 new packages to run now? [y/N] " },
      { kind: "log", line: "Approve each package to run (you can decline any):" },
      { kind: "approve", id: "dep.a" },
      { kind: "approve", id: "dep.b" },
      { kind: "approve", id: "root" },
    ]);
  });

  test("one package is named in the opening question", async () => {
    const { io, events } = fakeIo({ answer: false });
    await runPostInstallWalk(io, ["root"], []);
    expect(events[0]).toEqual({ kind: "confirm", question: "Approve root to run now? [y/N] " });
  });

  test("a no to the opening question approves nothing, logs the commands once, and still connects", async () => {
    const { io, events } = fakeIo({ answer: (q) => !q.startsWith("Approve ") });
    const github = { ...bundled("github", true), requiredBy: ["other.ext"] };
    await runPostInstallWalk(io, ["dep.a", "root"], [github]);
    expect(events).toEqual([
      { kind: "confirm", question: "Approve the 2 new packages to run now? [y/N] " },
      {
        kind: "log",
        line: "Not approved now; approve later with: nimbus extension approve dep.a && nimbus extension approve root",
      },
      { kind: "confirm", question: "This needs github. Connect now? [y/N] " },
      { kind: "connect", connector: "github", approved: [] },
    ]);
  });

  test("a no to the opening question counts every package as not approved for the connect phase", async () => {
    const { io, events } = fakeIo({ answer: (q) => !q.startsWith("Approve ") });
    const github = { ...bundled("github", true), requiredBy: ["dep.a", "root"] };
    await runPostInstallWalk(io, ["dep.a", "root"], [github]);
    expect(events.some((e) => e.kind === "approve" || e.kind === "connect")).toBe(false);
    expect(events).toContainEqual({
      kind: "log",
      line: "  github: skipped — dep.a, root not approved",
    });
  });

  test("an approval that cannot be asked stops the walk: no further approvals, no connect phase", async () => {
    const { io, events } = fakeIo({ brokenApprove: new Set(["dep.a"]) });
    await runPostInstallWalk(io, ["dep.a", "root"], [bundled("github", true)]);
    expect(events).toEqual([
      { kind: "confirm", question: "Approve the 2 new packages to run now? [y/N] " },
      { kind: "log", line: "Approve each package to run (you can decline any):" },
      { kind: "approve", id: "dep.a" },
      { kind: "log", line: "  dep.a: could not ask (socket gone)" },
      {
        kind: "log",
        line: "Approve later with: nimbus extension approve dep.a && nimbus extension approve root",
      },
    ]);
  });

  test("a connector is skipped when every package that requires it was declined", async () => {
    const { io, events } = fakeIo({ failApprove: new Set(["dep.a", "root"]) });
    const github = { ...bundled("github", true), requiredBy: ["dep.a", "root"] };
    const slack = { ...bundled("slack", true), requiredBy: ["dep.a", "kept.ext"] };
    await runPostInstallWalk(io, ["dep.a", "root"], [github, slack]);
    expect(events).toContainEqual({
      kind: "log",
      line: "  github: skipped — dep.a, root not approved",
    });
    expect(events).not.toContainEqual({
      kind: "confirm",
      question: "This needs github. Connect now? [y/N] ",
    });
    // One requiring package still runs, so slack is still offered.
    expect(events).toContainEqual({
      kind: "confirm",
      question: "This needs slack. Connect now? [y/N] ",
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
    expect(events).toContainEqual({ kind: "log", line: "  dep.b: not approved" });
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
      { kind: "confirm", question: "Approve root to run now? [y/N] " },
      { kind: "log", line: "Approve each package to run (you can decline any):" },
      { kind: "approve", id: "root" },
      { kind: "confirm", question: "This needs github. Connect now? [y/N] " },
      { kind: "connect", connector: "github", approved: ["root"] },
      { kind: "log", line: "  slack: connect it with: nimbus connector auth slack" },
    ]);
  });

  test("a no to the connect question connects nothing", async () => {
    const { io, events } = fakeIo({ answer: (q) => q.startsWith("Approve ") });
    await runPostInstallWalk(io, ["root"], [bundled("github", true)]);
    expect(events).toContainEqual({ kind: "approve", id: "root" });
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
    expect(runs).toEqual(["  not run — run it yourself: rm -rf / && nimbus connector auth github"]);
  });
});

describe("runConnectFix — && semantics", () => {
  test("an unrecognised command stops the rest; each remaining one is logged, not run", async () => {
    const runs: string[] = [];
    await runConnectFix(
      {
        ...bundled("github", true),
        fix: [
          "nimbus connector auth github",
          "nimbus connector frobnicate github",
          "nimbus extension credential set a.b token",
        ],
      },
      new Set(),
      {
        connectorAuth: async (id) => {
          runs.push(`auth ${id}`);
        },
        approve: async (id) => {
          runs.push(`approve ${id}`);
        },
        credentialSet: async (ext, name) => {
          runs.push(`credential ${ext} ${name}`);
        },
        log: (line) => {
          runs.push(line);
        },
      },
    );
    expect(runs).toEqual([
      "auth github",
      "  not run — run it yourself: nimbus connector frobnicate github",
      "  not run — run it yourself: nimbus extension credential set a.b token",
    ]);
  });
});

describe("runPostInstallWalk — a declined package", () => {
  test("a requirement whose fix approves a declined package is skipped, not asked", async () => {
    const { io, events } = fakeIo({ failApprove: new Set(["nimbus.readwise"]) });
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
    await runPostInstallWalk(io, ["nimbus.readwise", "root"], [owned, bundled("github", true)]);
    expect(events).toEqual([
      { kind: "confirm", question: "Approve the 2 new packages to run now? [y/N] " },
      { kind: "log", line: "Approve each package to run (you can decline any):" },
      { kind: "approve", id: "nimbus.readwise" },
      { kind: "log", line: "  nimbus.readwise: not approved" },
      { kind: "approve", id: "root" },
      { kind: "log", line: "  readwise: skipped — nimbus.readwise was not approved" },
      { kind: "confirm", question: "This needs github. Connect now? [y/N] " },
      { kind: "connect", connector: "github", approved: ["root"] },
    ]);
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
