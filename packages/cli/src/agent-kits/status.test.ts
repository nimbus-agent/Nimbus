import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPlan } from "./apply.ts";
import { fakeMachine, HOME, REPO } from "./fake-env.test-helpers.ts";
import type { KitId, KitScope } from "./kit-types.ts";
import { planKit } from "./kits/index.ts";
import { unifiedDiff } from "./line-diff.ts";
import { KitRefusal } from "./plan-files.ts";
import {
  agentVersion,
  answers,
  execForOutput,
  nodeKitEnv,
  readProcessEnv,
  resolveNimbusCommand,
} from "./production.ts";
import { allKitStatuses, kitStatus, needsAttention } from "./status.ts";

async function install(m: ReturnType<typeof fakeMachine>, kit: KitId, scope: KitScope) {
  expect((await applyPlan(planKit(kit, m.env, scope), m.fs, new Date(0))).failure).toBeUndefined();
}

describe("kit status", () => {
  test("nothing installed: every kit is not installed and nothing needs attention", () => {
    const statuses = allKitStatuses(fakeMachine().env);
    expect(statuses.map((s) => `${s.kit}:${s.scope}`)).toEqual([
      "claude-code:user",
      "claude-code:project",
      "codex:user",
      "cursor:user",
      "cursor:project",
      "vscode:user",
      "vscode:project",
    ]);
    expect(statuses.every((s) => !s.installed)).toBe(true);
    expect(needsAttention(statuses)).toBe(false);
  });

  test("outside a repository only user scope is looked at", () => {
    const statuses = allKitStatuses(fakeMachine({}, false).env);
    expect(statuses.map((s) => s.scope)).toEqual(["user", "user", "user", "user"]);
  });

  test("a fresh install is ok in every component", async () => {
    const m = fakeMachine();
    await install(m, "codex", "user");
    const s = kitStatus("codex", m.env, "user");
    expect(s.installed).toBe(true);
    expect(s.components.map((c) => [c.component, c.state])).toEqual([
      ["mcp", "ok"],
      ["steer", "ok"],
      ["instructions", "ok"],
    ]);
    expect(needsAttention([s])).toBe(false);
  });

  test("Claude Code at user scope: the settings are ok, the server is manual, and manual never needs attention", async () => {
    const m = fakeMachine();
    await install(m, "claude-code", "user");
    const s = kitStatus("claude-code", m.env, "user");
    expect(s.installed).toBe(true);
    expect(s.components).toEqual([
      { component: "steer", state: "ok", where: join(HOME, ".claude", "settings.json") },
      {
        component: "mcp",
        state: "manual",
        where:
          "claude mcp add --scope user nimbus -- nimbus mcp-server --stdio --agent claude-code",
      },
    ]);
    expect(needsAttention([s])).toBe(false);
    // A manual step alone is not an install.
    expect(kitStatus("claude-code", fakeMachine().env, "user").installed).toBe(false);
  });

  test("an edited block is drifted, a deleted file is missing, and both need attention", async () => {
    const m = fakeMachine();
    await install(m, "codex", "user");
    const rules = join(HOME, ".codex", "rules", "nimbus.rules");
    m.files.set(rules, (m.files.get(rules) ?? "").replace('"forbidden"', '"allow"'));
    m.files.delete(join(HOME, ".codex", "AGENTS.md"));
    const s = kitStatus("codex", m.env, "user");
    expect(s.components.map((c) => c.state)).toEqual(["ok", "drifted", "missing"]);
    expect(s.installed).toBe(true);
    expect(needsAttention([s])).toBe(true);
  });

  test("an edited key is drifted; a removed entry is missing", async () => {
    const m = fakeMachine();
    await install(m, "cursor", "user");
    const path = join(HOME, ".cursor", "mcp.json");
    m.files.set(path, (m.files.get(path) ?? "").replace('"cursor"', '"someone-else"'));
    expect(kitStatus("cursor", m.env, "user").components[0]?.state).toBe("drifted");
    m.files.set(path, '{\n  "mcpServers": {}\n}\n');
    const gone = kitStatus("cursor", m.env, "user");
    expect(gone.components[0]?.state).toBe("missing");
    expect(gone.installed).toBe(false);
    expect(needsAttention([gone])).toBe(false);
  });

  test("a file Nimbus cannot read for a kit that is not otherwise installed is cannot tell, and needs no attention", () => {
    const m = fakeMachine({ [join(REPO, ".vscode", "mcp.json")]: "{ // comments\n}" });
    const s = kitStatus("vscode", m.env, "project");
    expect(s.installed).toBe(false);
    expect(s.unreadable).toBeUndefined();
    expect(s.components.map((c) => [c.component, c.state])).toEqual([
      ["mcp", "cannot tell"],
      ["instructions", "missing"],
    ]);
    expect(s.components[0]?.reason).toContain("not strict JSON");
    expect(needsAttention([s])).toBe(false);
  });

  test("an installed kit keeps its other parts when one file can no longer be read as its own, and needs attention", async () => {
    const m = fakeMachine();
    await install(m, "cursor", "project");
    m.files.set(join(REPO, ".cursor", "rules", "nimbus.mdc"), "someone replaced this\n");
    const s = kitStatus("cursor", m.env, "project");
    expect(s.installed).toBe(true);
    expect(s.components.map((c) => [c.component, c.state])).toEqual([
      ["mcp", "ok"],
      ["instructions", "cannot tell"],
    ]);
    expect(s.components[1]?.reason).toContain("Nimbus did not write it");
    expect(needsAttention([s])).toBe(true);
  });

  test("a refusal of the whole kit (project scope outside a repository) is still reported as one", () => {
    const s = kitStatus("cursor", fakeMachine({}, false).env, "project");
    expect(s.installed).toBe(false);
    expect(s.unreadable).toContain("not the root of a git repository");
    expect(needsAttention([s])).toBe(false);
  });
});

describe("unifiedDiff", () => {
  test("a new file is all additions; an unchanged one is empty; line endings are not a change", () => {
    expect(unifiedDiff(null, "a\nb\n")).toBe("+ a\n+ b");
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
    expect(unifiedDiff("a\r\nb\r\n", "a\nb\n")).toBe("");
    expect(unifiedDiff("", "a")).toBe("+ a");
  });

  test("a change shows three lines of context and separates distant groups", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    const after = before.replace("line 2\n", "line two\n").replace("line 18", "line eighteen");
    expect(unifiedDiff(before, after)).toBe(
      [
        "  line 1",
        "- line 2",
        "+ line two",
        "  line 3",
        "  line 4",
        "  line 5",
        "...",
        "  line 15",
        "  line 16",
        "  line 17",
        "- line 18",
        "+ line eighteen",
        "  line 19",
        "  line 20",
      ].join("\n"),
    );
  });

  test("an appended block leaves the owner's lines as context", () => {
    expect(unifiedDiff("mine\n", "mine\n\nadded\n")).toBe("  mine\n+ \n+ added");
  });

  test("a very large pair falls back to whole-file remove and add rather than cutting it", () => {
    const big = Array.from({ length: 2100 }, (_, i) => `x${String(i)}`).join("\n");
    const out = unifiedDiff(big, `${big}\nlast`);
    expect(out.startsWith("- x0\n")).toBe(true);
    expect(out.endsWith("+ last")).toBe(true);
    expect(out.split("\n")).toHaveLength(2100 + 2101);
  });
});

describe("the real machine", () => {
  test("nodeKitEnv reads files, tells kinds apart, and treats an empty variable as unset", () => {
    const VARS: Record<string, string | undefined> = { SET: "v", EMPTY: "" };
    const root = mkdtempSync(join(tmpdir(), "nimbus-agent-env-"));
    try {
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "dir", "f.txt"), "hello");
      const env = nodeKitEnv({
        home: root,
        cwd: root,
        nimbus: "nimbus",
        envVar: (n) => VARS[n],
      });
      expect(env.read(join(root, "dir", "f.txt"))).toBe("hello");
      expect(env.read(join(root, "missing"))).toBeNull();
      expect(() => env.read(join(root, "dir"))).toThrow(KitRefusal);
      expect(env.kind(join(root, "dir"))).toBe("dir");
      expect(env.kind(join(root, "dir", "f.txt"))).toBe("file");
      expect(env.kind(join(root, "missing"))).toBe("absent");
      expect(env.envVar("SET")).toBe("v");
      expect(env.envVar("EMPTY")).toBeUndefined();
      expect(env.envVar("NOPE")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the server command is `nimbus` only when that name on PATH is this program", () => {
    const exe = join("/opt", "nimbus", "nimbus");
    const same = (p: string) => p;
    expect(resolveNimbusCommand(exe, () => exe, same)).toBe("nimbus");
    expect(resolveNimbusCommand(exe, () => join("/usr", "bin", "nimbus"), same)).toBe(exe);
    expect(resolveNimbusCommand(exe, () => null, same)).toBe(exe);
    // A link on PATH that resolves to this program counts.
    expect(
      resolveNimbusCommand(
        exe,
        () => "/link",
        (p) => (p === "/link" ? exe : p),
      ),
    ).toBe("nimbus");
    // A path that cannot be resolved is not this program.
    expect(
      resolveNimbusCommand(
        exe,
        () => "/broken",
        (p) => {
          if (p === "/broken") throw new Error("ENOENT");
          return p;
        },
      ),
    ).toBe(exe);
    expect(resolveNimbusCommand(join("C:", "x", "Nimbus.EXE"), () => null, same)).toBe(
      join("C:", "x", "Nimbus.EXE"),
    );
  });

  test("a source tree is refused: an agent's configuration must not point at a checkout", () => {
    for (const exe of [join("/usr", "bin", "bun"), join("C:", "bun", "bun.exe"), "node"]) {
      expect(() =>
        resolveNimbusCommand(
          exe,
          () => null,
          (p) => p,
        ),
      ).toThrow(/installed nimbus/);
    }
  });

  test("an agent's version is its first output line; a script shim is never started", async () => {
    const started: string[] = [];
    const run = (path: string, args: readonly string[]): Promise<string> => {
      started.push(`${path} ${args.join(" ")}`);
      return Promise.resolve("2.1.0 (Claude Code)\nmore\n");
    };
    expect(await agentVersion("claude", () => "/bin/claude", run)).toBe("2.1.0 (Claude Code)");
    expect(started).toEqual(["/bin/claude --version"]);
    for (const shim of [
      "C:/npm/claude.cmd",
      "C:/npm/claude.CMD",
      "/x/claude.bat",
      "/x/claude.ps1",
    ]) {
      expect(await agentVersion("claude", () => shim, run), shim).toBe("unknown");
    }
    expect(started).toHaveLength(1);
    expect(await agentVersion("claude", () => null, run)).toBe("not found");
    expect(
      await agentVersion(
        "claude",
        () => "/bin/claude",
        () => Promise.resolve("\n"),
      ),
    ).toBe("unknown");
    expect(
      await agentVersion(
        "claude",
        () => "/bin/claude",
        () => Promise.reject(new Error("timeout")),
      ),
    ).toBe("unknown");
    expect(
      await agentVersion(
        "claude",
        () => "/bin/claude",
        () => Promise.resolve("v".repeat(200)),
      ),
    ).toHaveLength(60);
  });

  test("a program's output is its stdout; a failure rejects; the probe turns either into yes or no", async () => {
    const ok = execForOutput((_f, _a, _o, cb) => cb(null, Buffer.from("out\n")));
    expect(await ok("/bin/x", ["--version"])).toBe("out\n");
    const bad = execForOutput((_f, _a, _o, cb) => cb(new Error("ETIMEDOUT"), ""));
    await expect(bad("/bin/x", [])).rejects.toThrow("ETIMEDOUT");
    expect(await answers(() => Promise.resolve({}))).toBe(true);
    expect(await answers(() => Promise.reject(new Error("no gateway")))).toBe(false);
    expect(readProcessEnv("NIMBUS_NO_SUCH_VARIABLE_ANYWHERE")).toBeUndefined();
    expect(readProcessEnv("PATH") ?? readProcessEnv("Path")).toBeDefined();
  });
});
