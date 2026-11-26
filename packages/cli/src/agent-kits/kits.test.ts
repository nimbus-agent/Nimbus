// The four agent kits, planned against an in-memory machine (no real home directory).
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { AGENT_DOOR_BOUNDS } from "../lib/agent-door-bounds.ts";
import { applyPlan, pendingEdits } from "./apply.ts";
import { fakeMachine, HOME, REPO } from "./fake-env.test-helpers.ts";
import { KIT_IDS, type KitId, type KitPlan, type KitScope } from "./kit-types.ts";
import { CLAUDE_DENY_RULES } from "./kits/claude-code.ts";
import { codexRulesBody, codexServerConflict } from "./kits/codex.ts";
import { NO_USER_STEERING } from "./kits/cursor.ts";
import { DEFAULT_SCOPE, planKit, SUPPORTED_SCOPES } from "./kits/index.ts";
import { VSCODE_LOCAL_HARNESS_NOTE } from "./kits/vscode.ts";
import { findBlock, jsonAt, KitRefusal, sameText } from "./plan-files.ts";
import { OWNER_COMMANDS, STEER_ROWS } from "./steer-table.ts";

const EVERY: Array<[KitId, KitScope]> = KIT_IDS.flatMap((kit) =>
  SUPPORTED_SCOPES[kit].map((scope): [KitId, KitScope] => [kit, scope]),
);

function fileOf(plan: KitPlan, suffix: string) {
  const f = plan.files.find((x) => x.path.endsWith(suffix));
  if (f === undefined) throw new Error(`no planned file ends with ${suffix}`);
  return f;
}

async function install(m: ReturnType<typeof fakeMachine>, kit: KitId, scope: KitScope) {
  const result = await applyPlan(planKit(kit, m.env, scope), m.fs, new Date(0));
  expect(result.failure).toBeUndefined();
  return result;
}

describe("every kit, every scope", () => {
  test.each(EVERY)(
    "%s (%s): the server entry is this machine's nimbus, labelled with the kit",
    (kit, scope) => {
      const m = fakeMachine();
      const plan = planKit(kit, m.env, scope);
      const text =
        plan.files.map((f) => f.after).join("\n") +
        plan.manual.map((s) => s.argv.join(" ")).join("\n");
      expect(text).toContain("mcp-server");
      expect(text).toContain("--stdio");
      expect(text).toContain(kit);
      // Whatever the file format, `--agent` is followed by this kit's own name.
      expect(text.replaceAll(/[\s",[\]]+/g, " ")).toContain(`--agent ${kit}`);
    },
  );

  test.each(EVERY)("%s (%s): a scope writes only in its own tree", (kit, scope) => {
    const m = fakeMachine();
    const plan = planKit(kit, m.env, scope);
    expect(plan.files.length).toBeGreaterThan(0);
    for (const f of plan.files) {
      expect(f.path.startsWith(scope === "user" ? HOME : REPO), f.path).toBe(true);
      expect(f.path.startsWith(scope === "user" ? REPO : HOME), f.path).toBe(false);
    }
  });

  test.each(EVERY)(
    "%s (%s): installing twice changes nothing the second time",
    async (kit, scope) => {
      const m = fakeMachine();
      await install(m, kit, scope);
      const again = planKit(kit, m.env, scope);
      expect(pendingEdits(again)).toEqual([]);
      for (const f of again.files) expect(f.present, f.path).toBe(true);
    },
  );

  test.each(EVERY)(
    "%s (%s): a link at ANY planned file, or at any directory between it and the scope's root, is refused",
    (kit, scope) => {
      const root = scope === "user" ? HOME : REPO;
      for (const file of planKit(kit, fakeMachine().env, scope).files) {
        const linkedFile = fakeMachine();
        linkedFile.links.add(file.path);
        expect(() => planKit(kit, linkedFile.env, scope), file.path).toThrow(
          /is not a regular file \(link\)/,
        );
        // Every directory strictly between the root and the file: the parent, and its parents.
        for (let dir = dirname(file.path); dir !== root; dir = dirname(dir)) {
          const linkedDir = fakeMachine();
          linkedDir.links.add(dir);
          expect(() => planKit(kit, linkedDir.env, scope), dir).toThrow(
            /is not a real directory \(link\)/,
          );
        }
        expect(file.root).toBe(root);
      }
    },
  );

  test("the agent's own directory variable must be absolute, and the link check then runs inside it", () => {
    for (const [kit, name] of [
      ["claude-code", "CLAUDE_CONFIG_DIR"],
      ["codex", "CODEX_HOME"],
      ["vscode", "COPILOT_HOME"],
    ] as const) {
      const relativeDir = fakeMachine();
      relativeDir.vars[name] = join(".", "conf");
      expect(() => planKit(kit, relativeDir.env, "user"), name).toThrow(/is not an absolute path/);
      const m = fakeMachine();
      const dir = join(HOME, "elsewhere", "conf");
      m.vars[name] = dir;
      const plan = planKit(kit, m.env, "user");
      for (const f of plan.files) {
        expect(f.path.startsWith(dir), f.path).toBe(true);
        expect(f.root).toBe(join(HOME, "elsewhere"));
      }
      m.links.add(dir);
      expect(() => planKit(kit, m.env, "user"), name).toThrow(/is not a real directory \(link\)/);
    }
  });

  test("project scope outside a repository is refused; Codex has no project scope", () => {
    const m = fakeMachine({}, false);
    for (const kit of ["claude-code", "cursor", "vscode"] as const) {
      expect(() => planKit(kit, m.env, "project"), kit).toThrow(/not the root of a git repository/);
    }
    expect(() => planKit("codex", fakeMachine().env, "project")).toThrow(/user scope only/);
    expect(DEFAULT_SCOPE).toEqual({
      "claude-code": "user",
      codex: "user",
      cursor: "user",
      vscode: "project",
    });
  });

  test("every kit that has an instructions file says the same thing: each steer row, the three owner commands, the bounds", () => {
    const withInstructions: Array<[KitId, KitScope]> = [
      ["codex", "user"],
      ["cursor", "project"],
      ["vscode", "project"],
    ];
    for (const [kit, scope] of withInstructions) {
      const plan = planKit(kit, fakeMachine().env, scope);
      const text = plan.files.find((f) => f.component === "instructions")?.after ?? "";
      for (const row of STEER_ROWS) expect(text, kit).toContain(row.actionType);
      for (const c of OWNER_COMMANDS) expect(text, kit).toContain(`\`${c.join(" ")}\``);
      expect(text, kit).toContain(AGENT_DOOR_BOUNDS);
    }
  });
});

describe("claude-code", () => {
  const SETTINGS = join(HOME, ".claude", "settings.json");

  test("user scope: the hook and the deny rules go into settings.json; the server is one command the owner runs", () => {
    const plan = planKit("claude-code", fakeMachine().env, "user");
    expect(plan.enforcement).toBe("hook");
    expect(plan.files.map((f) => f.path)).toEqual([SETTINGS]);
    expect(JSON.parse(plan.files[0]?.after ?? "")).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|PowerShell",
            hooks: [{ type: "command", command: "nimbus", args: ["agent", "hook", "claude-code"] }],
          },
        ],
      },
      permissions: {
        deny: [
          "Bash(nimbus approvals *)",
          "Bash(nimbus connector writes *)",
          "Bash(nimbus captures *)",
        ],
      },
    });
    expect(plan.manual).toHaveLength(1);
    expect(plan.manual[0]?.argv).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "nimbus",
      "--",
      "nimbus",
      "mcp-server",
      "--stdio",
      "--agent",
      "claude-code",
    ]);
  });

  test("CLAUDE_CONFIG_DIR moves the settings file", () => {
    const m = fakeMachine();
    m.vars["CLAUDE_CONFIG_DIR"] = join(HOME, "elsewhere");
    expect(planKit("claude-code", m.env, "user").files[0]?.path).toBe(
      join(HOME, "elsewhere", "settings.json"),
    );
  });

  test("the owner's own hooks, deny rules and other settings are all kept, in place", async () => {
    const mine = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "bell" }] }],
      },
      permissions: { allow: ["Bash(npm run *)"], deny: ["Bash(git push *)"] },
    };
    const m = fakeMachine({ [SETTINGS]: `${JSON.stringify(mine, null, 2)}\n` });
    await install(m, "claude-code", "user");
    const after = JSON.parse(m.files.get(SETTINGS) ?? "") as typeof mine;
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toEqual(mine.hooks.Stop);
    expect(after.hooks.PreToolUse[0]).toEqual(mine.hooks.PreToolUse[0]);
    expect(after.hooks.PreToolUse).toHaveLength(2);
    expect(after.permissions.allow).toEqual(["Bash(npm run *)"]);
    expect(after.permissions.deny).toEqual(["Bash(git push *)", ...CLAUDE_DENY_RULES]);
  });

  test("an older hook entry is replaced in place, never duplicated, and a removed deny rule comes back", async () => {
    const m = fakeMachine();
    await install(m, "claude-code", "user");
    const edited = JSON.parse(m.files.get(SETTINGS) ?? "") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      permissions: { deny: string[] };
    };
    const group = edited.hooks.PreToolUse[0];
    if (group?.hooks[0] === undefined) throw new Error("no hook");
    group.hooks[0].command = "/old/path/nimbus";
    edited.permissions.deny = edited.permissions.deny.slice(1);
    m.files.set(SETTINGS, `${JSON.stringify(edited, null, 2)}\n`);
    const plan = planKit("claude-code", m.env, "user");
    expect(plan.files[0]?.present).toBe(true);
    const after = JSON.parse(plan.files[0]?.after ?? "") as typeof edited;
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("nimbus");
    expect([...after.permissions.deny].sort()).toEqual([...CLAUDE_DENY_RULES].sort());
  });

  test("a hook group the owner added a handler to keeps that handler and its matcher; only the Nimbus one is replaced", async () => {
    const m = fakeMachine();
    await install(m, "claude-code", "user");
    const edited = JSON.parse(m.files.get(SETTINGS) ?? "") as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    const group = edited.hooks.PreToolUse[0];
    if (group === undefined) throw new Error("no group");
    group.matcher = "Bash";
    group.hooks.unshift({ type: "command", command: "my-audit.sh" });
    const mine = group.hooks[1];
    if (mine === undefined) throw new Error("no nimbus handler");
    mine["command"] = "/old/nimbus";
    m.files.set(SETTINGS, `${JSON.stringify(edited, null, 2)}\n`);
    const after = JSON.parse(
      planKit("claude-code", m.env, "user").files[0]?.after ?? "",
    ) as typeof edited;
    expect(after.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "my-audit.sh" },
          { type: "command", command: "nimbus", args: ["agent", "hook", "claude-code"] },
        ],
      },
    ]);
  });

  test("settings that are not strict JSON, or whose hooks is not an object, are refused", () => {
    for (const bad of ["{ // mine\n}", '{"hooks": []}', '{"permissions": {"deny": "all"}}']) {
      const m = fakeMachine({ [SETTINGS]: bad });
      expect(() => planKit("claude-code", m.env, "user"), bad).toThrow(KitRefusal);
    }
  });

  test("project scope writes .mcp.json and .claude/settings.json and has no manual step", () => {
    const plan = planKit("claude-code", fakeMachine().env, "project");
    expect(plan.manual).toEqual([]);
    expect(plan.files.map((f) => f.path)).toEqual([
      join(REPO, ".mcp.json"),
      join(REPO, ".claude", "settings.json"),
    ]);
    expect(JSON.parse(fileOf(plan, ".mcp.json").after)).toEqual({
      mcpServers: {
        nimbus: { command: "nimbus", args: ["mcp-server", "--stdio", "--agent", "claude-code"] },
      },
    });
  });
});

describe("codex", () => {
  const CONFIG = join(HOME, ".codex", "config.toml");

  test("the server table, the rules file and the instructions are three owned blocks", () => {
    const plan = planKit("codex", fakeMachine().env, "user");
    expect(plan.enforcement).toBe("rules");
    expect(plan.notes).toEqual([]);
    expect(plan.files.map((f) => [f.component, f.path])).toEqual([
      ["mcp", CONFIG],
      ["steer", join(HOME, ".codex", "rules", "nimbus.rules")],
      ["instructions", join(HOME, ".codex", "AGENTS.md")],
    ]);
    expect(findBlock(fileOf(plan, "config.toml").after, "codex", "hash")?.body).toBe(
      '[mcp_servers.nimbus]\ncommand = "nimbus"\nargs = ["mcp-server", "--stdio", "--agent", "codex"]',
    );
  });

  test("a Windows path is a valid TOML string (backslashes escaped)", () => {
    const m = fakeMachine();
    const env = { ...m.env, nimbus: "C:\\Program Files\\Nimbus\\nimbus.exe" }; // cross-platform-ok
    expect(fileOf(planKit("codex", env, "user"), "config.toml").after).toContain(
      String.raw`command = "C:\\Program Files\\Nimbus\\nimbus.exe"`,
    );
  });

  test("there is one forbidden rule per steer row and per owner command, each with its own examples", () => {
    const body = codexRulesBody();
    expect(body.split("prefix_rule(").length - 1).toBe(STEER_ROWS.length + OWNER_COMMANDS.length);
    expect(body.split('decision = "forbidden"').length - 1).toBe(
      STEER_ROWS.length + OWNER_COMMANDS.length,
    );
    expect(body).toContain('pattern = ["gh", "pr", "merge"],');
    expect(body).toContain('match = ["gh pr merge", "gh pr merge --help"],');
    expect(body).toContain('pattern = ["nimbus", "approvals"],');
    expect(body).toContain("propose_action tool with type github.pr.merge");
    // A row limited to deployments lists the kinds as alternatives for the next word.
    expect(body).toContain(
      'pattern = ["kubectl", "scale", ["deployment", "deployments", "deploy", "deployment.apps"]],',
    );
    expect(body).toContain('match = ["kubectl scale deployment", "kubectl scale deployment web"],');
    expect(body).not.toContain('"allow"');
  });

  test("the owner's config is kept and the block is appended; CODEX_HOME moves it", async () => {
    const mine = 'model = "o"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const m = fakeMachine({ [CONFIG]: mine });
    await install(m, "codex", "user");
    const after = m.files.get(CONFIG) ?? "";
    expect(after.startsWith(`${mine}\n# >>> nimbus agent kit codex v`)).toBe(true);
    m.vars["CODEX_HOME"] = join(HOME, "cx");
    expect(planKit("codex", m.env, "user").files[0]?.path).toBe(join(HOME, "cx", "config.toml"));
  });

  test("anything that would make the appended table invalid TOML is refused, in any spelling", () => {
    const refused = [
      "[mcp_servers.nimbus]",
      "  [ mcp_servers . nimbus ]",
      '[mcp_servers."nimbus"]',
      "[mcp_servers.nimbus.env]",
      // An inline table cannot be added to.
      'mcp_servers = { other = { command = "other" } }',
      '"mcp_servers" = {}',
      // Dotted keys define the same table.
      'mcp_servers.nimbus.command = "x"',
      'mcp_servers . "nimbus" = { command = "x" }',
      '[mcp_servers]\nnimbus = { command = "x" }',
      '[mcp_servers]\n# mine\nnimbus.command = "x"',
    ];
    for (const text of refused) {
      const m = fakeMachine({ [CONFIG]: `${text}\ncommand = "x"\n` });
      expect(() => planKit("codex", m.env, "user"), text).toThrow(KitRefusal);
      expect(codexServerConflict(text), text).toBeDefined();
    }
    const fine = [
      '[mcp_servers.nimbus2]\ncommand = "x"',
      '[mcp_servers.other]\ncommand = "nimbus"',
      '[mcp_servers]\nother = { command = "x" }',
      "[other]\nnimbus = 1\nmcp_servers = 2",
      '# mcp_servers = { }\nmodel = "o"',
      "",
    ];
    for (const text of fine) {
      expect(codexServerConflict(text), text).toBeUndefined();
      const m = fakeMachine({ [CONFIG]: `${text}\n` });
      expect(() => planKit("codex", m.env, "user"), text).not.toThrow();
    }
  });
});

describe("cursor", () => {
  test("user scope writes the server only and says there is no steering there", () => {
    const plan = planKit("cursor", fakeMachine().env, "user");
    expect(plan.enforcement).toBe("none");
    expect(plan.notes).toEqual([NO_USER_STEERING]);
    expect(plan.files.map((f) => f.path)).toEqual([join(HOME, ".cursor", "mcp.json")]);
    expect(JSON.parse(plan.files[0]?.after ?? "")).toEqual({
      mcpServers: {
        nimbus: {
          type: "stdio",
          command: "nimbus",
          args: ["mcp-server", "--stdio", "--agent", "cursor"],
        },
      },
    });
  });

  test("project scope adds a rules file that starts with the always-apply front matter", () => {
    const plan = planKit("cursor", fakeMachine().env, "project");
    expect(plan.enforcement).toBe("guidance only");
    const rules = fileOf(plan, "nimbus.mdc");
    expect(rules.path).toBe(join(REPO, ".cursor", "rules", "nimbus.mdc"));
    expect(
      rules.after.startsWith("---\nalwaysApply: true\n---\n\n<!-- >>> nimbus agent kit cursor v"),
    ).toBe(true);
  });

  test("a nimbus.mdc Nimbus did not write is refused; one it wrote is rewritten whole", async () => {
    const path = join(REPO, ".cursor", "rules", "nimbus.mdc");
    const foreign = fakeMachine({ [path]: "my own rules\n" });
    expect(() => planKit("cursor", foreign.env, "project")).toThrow(/Nimbus did not write it/);
    const m = fakeMachine();
    await install(m, "cursor", "project");
    m.files.set(path, `${m.files.get(path) ?? ""}\nstray line\n`);
    const plan = planKit("cursor", m.env, "project");
    expect(fileOf(plan, "nimbus.mdc").after).not.toContain("stray line");
  });

  test("a rules file checked out with CRLF keeps CRLF and needs no change", async () => {
    const path = join(REPO, ".cursor", "rules", "nimbus.mdc");
    const m = fakeMachine();
    await install(m, "cursor", "project");
    const crlf = (m.files.get(path) ?? "").replaceAll("\n", "\r\n");
    m.files.set(path, crlf);
    const plan = planKit("cursor", m.env, "project");
    expect(fileOf(plan, "nimbus.mdc").after).toBe(crlf);
    expect(pendingEdits(plan)).toEqual([]);
  });
});

describe("vscode", () => {
  test("user scope writes the Copilot file, with the tools list the documented example carries", () => {
    const m = fakeMachine();
    const plan = planKit("vscode", m.env, "user");
    expect(plan.enforcement).toBe("none");
    expect(plan.files.map((f) => f.path)).toEqual([join(HOME, ".copilot", "mcp-config.json")]);
    expect(jsonAt(plan.files[0]?.after ?? "", ["mcpServers", "nimbus"])).toEqual({
      type: "stdio",
      command: "nimbus",
      args: ["mcp-server", "--stdio", "--agent", "vscode"],
      tools: ["*"],
    });
    m.vars["COPILOT_HOME"] = join(HOME, "cp");
    expect(planKit("vscode", m.env, "user").files[0]?.path).toBe(
      join(HOME, "cp", "mcp-config.json"),
    );
  });

  test("project scope writes .vscode/mcp.json (servers) and the Copilot instructions block", () => {
    const plan = planKit("vscode", fakeMachine().env, "project");
    expect(plan.notes).toEqual([VSCODE_LOCAL_HARNESS_NOTE]);
    expect(jsonAt(fileOf(plan, "mcp.json").after, ["servers", "nimbus"])).toEqual({
      type: "stdio",
      command: "nimbus",
      args: ["mcp-server", "--stdio", "--agent", "vscode"],
    });
    expect(fileOf(plan, "copilot-instructions.md").path).toBe(
      join(REPO, ".github", "copilot-instructions.md"),
    );
  });

  test("a .vscode/mcp.json with comments is refused with the reason, and the owner's instructions are kept", async () => {
    const withComments = fakeMachine({
      [join(REPO, ".vscode", "mcp.json")]: '{\n  // my servers\n  "servers": {}\n}\n',
    });
    expect(() => planKit("vscode", withComments.env, "project")).toThrow(/not strict JSON/);
    const path = join(REPO, ".github", "copilot-instructions.md");
    const m = fakeMachine({ [path]: "# House rules\n\nUse tabs.\n" });
    await install(m, "vscode", "project");
    expect(
      (m.files.get(path) ?? "").startsWith("# House rules\n\nUse tabs.\n\n<!-- >>> nimbus"),
    ).toBe(true);
  });
});

describe("two kits in one repository", () => {
  test("claude-code and vscode at project scope write different files, and each stays as it was after the other", async () => {
    const m = fakeMachine();
    await install(m, "claude-code", "project");
    await install(m, "vscode", "project");
    await install(m, "cursor", "project");
    for (const kit of ["claude-code", "vscode", "cursor"] as const) {
      expect(pendingEdits(planKit(kit, m.env, "project")), kit).toEqual([]);
    }
    expect(
      jsonAt(m.files.get(join(REPO, ".mcp.json")) ?? "", ["mcpServers", "nimbus", "args"]),
    ).toEqual(["mcp-server", "--stdio", "--agent", "claude-code"]);
  });

  test("a file converted to CRLF after install still needs no change", async () => {
    const m = fakeMachine();
    await install(m, "codex", "user");
    for (const [path, text] of [...m.files]) m.files.set(path, text.replaceAll("\n", "\r\n"));
    const plan = planKit("codex", m.env, "user");
    expect(pendingEdits(plan)).toEqual([]);
    for (const f of plan.files) expect(sameText(f.before ?? "", f.after)).toBe(true);
  });
});
