import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { applyPlan } from "../agent-kits/apply.ts";
import { fakeMachine, HOME, REPO } from "../agent-kits/fake-env.test-helpers.ts";
import { KitRefusal } from "../agent-kits/plan-files.ts";
import { AGENT_DOOR_BOUNDS } from "../lib/agent-door-bounds.ts";
import {
  AGENT_USAGE,
  type AgentCmdDeps,
  NOT_A_BOUNDARY,
  OUTSIDE_THE_DOOR,
  parseAgentArgs,
  runAgentWith,
} from "./agent.ts";

interface Harness {
  readonly deps: AgentCmdDeps;
  readonly m: ReturnType<typeof fakeMachine>;
  readonly out: string[];
  readonly err: string[];
  readonly asked: string[];
  applied: number;
  versions: string[];
}

function harness(
  over: {
    tty?: boolean;
    answer?: string;
    gateway?: boolean;
    stdin?: string | (() => Promise<string>);
    env?: () => never;
    files?: Record<string, string>;
    repo?: boolean;
  } = {},
): Harness {
  const m = fakeMachine(over.files ?? {}, over.repo ?? true);
  const stdin = over.stdin ?? "";
  const readStdin = typeof stdin === "function" ? stdin : () => Promise.resolve(stdin);
  const h: Harness = {
    m,
    out: [],
    err: [],
    asked: [],
    applied: 0,
    versions: [],
    deps: {
      env: over.env ?? (() => m.env),
      tty: { stdin: over.tty ?? true, stdout: over.tty ?? true },
      ask: (q) => {
        h.asked.push(q);
        return Promise.resolve(over.answer ?? "yes");
      },
      out: (s) => {
        h.out.push(s);
      },
      err: (s) => {
        h.err.push(s);
      },
      apply: (plan) => {
        h.applied += 1;
        return applyPlan(plan, m.fs, new Date(0));
      },
      versionOf: (program) => {
        h.versions.push(program);
        return Promise.resolve(`${program} 9.9.9`);
      },
      gatewayAnswers: () => Promise.resolve(over.gateway ?? true),
      readStdin,
    },
  };
  return h;
}

const text = (lines: string[]): string => lines.join("");

describe("parseAgentArgs", () => {
  test.each([
    [
      ["install", "claude-code"],
      { verb: "install", kit: "claude-code", scope: undefined, dryRun: false, yes: false },
    ],
    [
      ["install", "--scope", "project", "cursor", "--dry-run"],
      { verb: "install", kit: "cursor", scope: "project", dryRun: true, yes: false },
    ],
    [
      ["install", "codex", "--yes", "--scope", "user"],
      { verb: "install", kit: "codex", scope: "user", dryRun: false, yes: true },
    ],
    [["status"], { verb: "status", json: false }],
    [["status", "--json"], { verb: "status", json: true }],
    [["hook", "claude-code"], { verb: "hook", kit: "claude-code" }],
  ])("%j", (argv, want) => {
    expect(parseAgentArgs(argv)).toEqual(want as ReturnType<typeof parseAgentArgs>);
  });

  test.each([
    [[]],
    [["install"]],
    [["install", "emacs"]],
    [["install", "codex", "cursor"]],
    [["install", "codex", "--scope"]],
    [["install", "codex", "--scope", "global"]],
    [["install", "codex", "--scope", "user", "--scope", "user"]],
    [["install", "codex", "--force"]],
    [["status", "--yaml"]],
    [["status", "--json", "--json"]],
    [["hook"]],
    [["hook", "cursor"]],
    [["hook", "claude-code", "extra"]],
    [["uninstall"]],
    [["remove", "codex"]],
  ])("usage error: %j", (argv) => {
    expect(parseAgentArgs(argv)).toBeUndefined();
  });

  test("a usage error prints the usage on stderr and exits 2", async () => {
    const h = harness();
    expect(await runAgentWith(["install", "emacs"], h.deps)).toBe(2);
    expect(text(h.err)).toBe(`${AGENT_USAGE}\n`);
    expect(h.out).toEqual([]);
  });
});

describe("nimbus agent install", () => {
  test("shows every change, the manual step, that steering is not a boundary, and the bounds, BEFORE it asks", async () => {
    const h = harness();
    expect(await runAgentWith(["install", "claude-code"], h.deps)).toBe(0);
    const shown = text(h.out);
    const settings = join(HOME, ".claude", "settings.json");
    expect(shown).toContain("Nimbus agent kit: claude-code (user scope)");
    expect(shown).toContain(`Steering: hook. ${NOT_A_BOUNDARY}`);
    expect(shown).toContain(`Create ${settings}`);
    expect(shown).toContain('+         "matcher": "Bash|PowerShell",');
    expect(shown).toContain(
      "  claude mcp add --scope user nimbus -- nimbus mcp-server --stdio --agent claude-code",
    );
    expect(shown).toContain(AGENT_DOOR_BOUNDS);
    expect(shown).toContain(OUTSIDE_THE_DOOR);
    expect(h.asked).toEqual(["Type yes to write these changes: "]);
    // Everything above was printed before the question, in one piece.
    expect(h.out[0]).toContain(OUTSIDE_THE_DOOR);
    expect(h.applied).toBe(1);
    expect(h.m.files.has(settings)).toBe(true);
    expect(shown).toContain(`Created ${settings}`);
    expect(shown).toContain("nimbus agent status");
  });

  test("a changed file is announced with its backup, and the diff leaves the owner's lines as context", async () => {
    const path = join(HOME, ".cursor", "mcp.json");
    const h = harness({ files: { [path]: '{\n  "mcpServers": {\n    "mine": {}\n  }\n}\n' } });
    expect(await runAgentWith(["install", "cursor"], h.deps)).toBe(0);
    const shown = text(h.out);
    expect(shown).toContain(`Change ${path} (the file as it is now is kept beside it`);
    expect(shown).toContain('    "mine": {}');
    expect(shown).toContain('+     "nimbus": {');
    expect(shown).toContain(`Changed ${path} (before: ${path}.nimbus-bak-19700101T000000Z)`);
  });

  test.each(["", "y", "Yes", "YES", "yes please", "no"])(
    "anything but the word yes writes nothing (%j)",
    async (answer) => {
      const h = harness({ answer });
      expect(await runAgentWith(["install", "codex"], h.deps)).toBe(1);
      expect(h.applied).toBe(0);
      expect(text(h.out)).toContain("Nothing was written.");
      expect([...h.m.files.keys()].some((k) => k.includes(".codex"))).toBe(false);
    },
  );

  test("--dry-run prints the plan and neither asks nor writes", async () => {
    const h = harness();
    expect(await runAgentWith(["install", "codex", "--dry-run"], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.applied).toBe(0);
    expect(text(h.out)).toContain("Dry run: nothing was written.");
  });

  test("with no terminal it refuses rather than write unasked; --yes is the stated way past", async () => {
    const h = harness({ tty: false });
    expect(await runAgentWith(["install", "codex"], h.deps)).toBe(1);
    expect(h.applied).toBe(0);
    expect(h.asked).toEqual([]);
    expect(text(h.err)).toContain("asks first");
    const y = harness({ tty: false });
    expect(await runAgentWith(["install", "codex", "--yes"], y.deps)).toBe(0);
    expect(y.asked).toEqual([]);
    expect(y.applied).toBe(1);
  });

  test("an install that changes nothing says so and does not ask", async () => {
    const h = harness();
    await runAgentWith(["install", "codex", "--yes"], h.deps);
    h.out.length = 0;
    expect(await runAgentWith(["install", "codex"], h.deps)).toBe(0);
    expect(text(h.out)).toContain("No file needs to change.");
    expect(h.asked).toEqual([]);
    expect(h.applied).toBe(1);
  });

  test("the default scope is the kit's own, and --scope overrides it", async () => {
    const h = harness();
    await runAgentWith(["install", "vscode", "--dry-run"], h.deps);
    expect(text(h.out)).toContain("vscode (project scope)");
    expect(text(h.out)).toContain(join(REPO, ".vscode", "mcp.json"));
    const u = harness();
    await runAgentWith(["install", "vscode", "--scope", "user", "--dry-run"], u.deps);
    expect(text(u.out)).toContain(join(HOME, ".copilot", "mcp-config.json"));
    expect(text(u.out)).toContain("Note: no steering at user scope");
  });

  test("a refusal is one line on stderr, exit 1, and nothing is asked or written", async () => {
    const cases: Array<[string[], Parameters<typeof harness>[0], RegExp]> = [
      [["install", "codex", "--scope", "project"], {}, /user scope only/],
      [
        ["install", "cursor", "--scope", "project"],
        { repo: false },
        /not the root of a git repository/,
      ],
      [
        ["install", "claude-code"],
        { files: { [join(HOME, ".claude", "settings.json")]: "{ // mine\n}" } },
        /not strict JSON/,
      ],
      [
        ["install", "codex"],
        {
          env: () => {
            throw new KitRefusal("nimbus agent install needs an installed nimbus");
          },
        },
        /needs an installed nimbus/,
      ],
    ];
    for (const [argv, over, want] of cases) {
      const h = harness(over);
      expect(await runAgentWith(argv, h.deps), argv.join(" ")).toBe(1);
      expect(text(h.err)).toMatch(want);
      expect(h.asked).toEqual([]);
      expect(h.applied).toBe(0);
    }
  });

  test("a file that cannot be replaced is reported after the files that were written", async () => {
    const h = harness();
    let renames = 0;
    h.m.fs.renameError = () =>
      ++renames > 1 ? Object.assign(new Error("full"), { code: "ENOSPC" }) : undefined;
    expect(await runAgentWith(["install", "codex", "--yes"], h.deps)).toBe(1);
    expect(text(h.out)).toContain(`Created ${join(HOME, ".codex", "config.toml")}`);
    expect(text(h.err)).toContain("could not be replaced");
    expect(text(h.out)).not.toContain("Check it any time");
  });

  test("control characters in an existing file never reach the terminal", async () => {
    const path = join(HOME, ".codex", "config.toml");
    const esc = String.fromCharCode(27);
    const h = harness({ files: { [path]: `title = "${esc}[2Jgone"\n` } });
    await runAgentWith(["install", "codex", "--dry-run"], h.deps);
    expect(text(h.out)).not.toContain(esc);
    expect(text(h.out)).toContain('title = "[2Jgone"');
  });

  test("an error that is not a refusal is not swallowed", async () => {
    const h = harness({
      env: () => {
        throw new TypeError("bug");
      },
    });
    await expect(runAgentWith(["install", "codex"], h.deps)).rejects.toThrow("bug");
  });
});

describe("nimbus agent status", () => {
  test("nothing installed: says so, prints the bounds, exit 0, and starts no agent program", async () => {
    const h = harness();
    expect(await runAgentWith(["status"], h.deps)).toBe(0);
    const shown = text(h.out);
    expect(shown).toContain("No agent kit is installed.");
    expect(shown).toContain("gateway: running");
    expect(shown).toContain(NOT_A_BOUNDARY);
    expect(shown).toContain(AGENT_DOOR_BOUNDS);
    expect(shown).toContain(OUTSIDE_THE_DOOR);
    expect(h.versions).toEqual([]);
  });

  test("Claude Code at user scope is healthy with its manual step shown: exit 0", async () => {
    const h = harness({ gateway: false });
    await runAgentWith(["install", "claude-code", "--yes"], h.deps);
    h.out.length = 0;
    expect(await runAgentWith(["status"], h.deps)).toBe(0);
    const shown = text(h.out);
    expect(shown).toContain("claude-code (user): steering hook; agent version claude 9.9.9");
    expect(shown).toContain(`  steer: ok  ${join(HOME, ".claude", "settings.json")}`);
    expect(shown).toContain(
      "  mcp: manual (Nimbus cannot read where this lands). Command: claude mcp add --scope user nimbus",
    );
    expect(shown).toContain("gateway: not running");
    expect(shown).not.toContain("not installed");
    expect(h.versions).toEqual(["claude"]);
  });

  test("a drifted component is named, the exit code is 1, and status never writes", async () => {
    const h = harness();
    await runAgentWith(["install", "codex", "--yes"], h.deps);
    const rules = join(HOME, ".codex", "rules", "nimbus.rules");
    h.m.files.set(rules, `${h.m.files.get(rules) ?? ""}# edited\n`.replace("forbidden", "allow"));
    const before = new Map(h.m.files);
    h.out.length = 0;
    const applied = h.applied;
    expect(await runAgentWith(["status"], h.deps)).toBe(1);
    const shown = text(h.out);
    expect(shown).toContain(`  steer: drifted  ${rules}`);
    expect(shown).toContain("  mcp: ok");
    expect(shown).not.toContain("not yet verified against a real Codex");
    expect(shown).toContain("nimbus agent install <kit> --dry-run");
    expect(h.applied).toBe(applied);
    expect(new Map(h.m.files)).toEqual(before);
  });

  test("a file Nimbus cannot read, for a kit that is not installed, changes nothing", async () => {
    const h = harness({ files: { [join(REPO, ".vscode", "mcp.json")]: "{ // c\n}" } });
    expect(await runAgentWith(["status"], h.deps)).toBe(0);
    expect(text(h.out)).toContain("No agent kit is installed.");
  });

  test("an installed kit with a file it can no longer read says cannot tell, with the reason, and exits 1", async () => {
    const h = harness();
    await runAgentWith(["install", "cursor", "--scope", "project", "--yes"], h.deps);
    const rules = join(REPO, ".cursor", "rules", "nimbus.mdc");
    h.m.files.set(rules, "replaced\n");
    h.out.length = 0;
    expect(await runAgentWith(["status"], h.deps)).toBe(1);
    const shown = text(h.out);
    expect(shown).toContain("  mcp: ok");
    expect(shown).toContain(`  instructions: cannot tell  ${rules} (`);
    expect(shown).toContain("Nimbus did not write it");
  });

  test("a path with a control character, and a nimbus path with a space, are printed safely", async () => {
    const h = harness();
    const esc = String.fromCharCode(27);
    const env = {
      ...h.m.env,
      home: `${h.m.env.home}${esc}[31m`,
      nimbus: join("C:", "Program Files", "Nimbus", "nimbus.exe"),
    };
    const deps = { ...h.deps, env: () => env };
    expect(await runAgentWith(["install", "claude-code", "--dry-run"], deps)).toBe(0);
    const shown = text(h.out);
    expect(shown).not.toContain(esc);
    expect(shown).toContain("Create ");
    // The executable with a space is one quoted word, so the printed command can be pasted.
    expect(shown).toMatch(
      /claude mcp add --scope user nimbus -- ['"].*Program Files.*nimbus\.exe['"] mcp-server/,
    );
  });

  test("--json carries the same facts and the same exit code", async () => {
    const h = harness({ gateway: false });
    await runAgentWith(["install", "cursor", "--scope", "project", "--yes"], h.deps);
    h.m.files.delete(join(REPO, ".cursor", "rules", "nimbus.mdc"));
    h.out.length = 0;
    expect(await runAgentWith(["status", "--json"], h.deps)).toBe(1);
    const parsed = JSON.parse(text(h.out)) as {
      kits: Array<{
        kit: string;
        scope: string;
        installed: boolean;
        enforcement: string;
        agentVersion: string | null;
        components: Array<{ component: string; state: string }>;
      }>;
      gateway: string;
      needsAttention: boolean;
      bounds: string;
      outsideTheDoor: string;
    };
    expect(parsed.gateway).toBe("not running");
    expect(parsed.needsAttention).toBe(true);
    expect(parsed.bounds).toBe(AGENT_DOOR_BOUNDS);
    expect(parsed.outsideTheDoor).toBe(OUTSIDE_THE_DOOR);
    const cursor = parsed.kits.find((k) => k.kit === "cursor" && k.scope === "project");
    expect(cursor).toMatchObject({
      installed: true,
      enforcement: "guidance only",
      agentVersion: null,
    });
    expect(cursor?.components.map((c) => c.state)).toEqual(["ok", "missing"]);
    expect(parsed.kits).toHaveLength(7);
  });

  test("the self-approval sentence opens what an agent can still do outside the door", () => {
    expect(
      OUTSIDE_THE_DOOR.startsWith("An agent with a shell can run `nimbus approvals <id>` itself"),
    ).toBe(true);
    expect(OUTSIDE_THE_DOOR).toContain("can still approve its own proposals");
  });
});

describe("nimbus agent hook claude-code", () => {
  const call = (command: string): string =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  test("a steered command is answered with a deny on stdout; exit 0", async () => {
    const h = harness({ stdin: call("gh pr merge 7") });
    expect(await runAgentWith(["hook", "claude-code"], h.deps)).toBe(0);
    expect(JSON.parse(text(h.out))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(h.err).toEqual([]);
  });

  test("anything else, unreadable stdin included, is silence and exit 0; the environment is never built", async () => {
    const env = (): never => {
      throw new Error("the hook must not need the kit environment");
    };
    for (const stdin of [call("ls -la"), "garbage", ""]) {
      const h = harness({ stdin, env });
      expect(await runAgentWith(["hook", "claude-code"], h.deps)).toBe(0);
      expect(text(h.out)).toBe("");
      expect(h.err).toEqual([]);
    }
    const broken = harness({ stdin: () => Promise.reject(new Error("closed")), env });
    expect(await runAgentWith(["hook", "claude-code"], broken.deps)).toBe(0);
    expect(text(broken.out)).toBe("");
  });
});
