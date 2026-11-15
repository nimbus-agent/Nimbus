import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AGENT_DOOR_BOUNDS } from "../lib/agent-door-bounds.ts";
import { decideCommand, decideHook, hookOutput } from "./hook.ts";
import {
  matchSteer,
  OWNER_COMMAND_REASON,
  OWNER_COMMANDS,
  renderInstructions,
  STEER_ROWS,
  STEER_TABLE_VERSION,
  steerReason,
} from "./steer-table.ts";

function bash(command: string, tool = "Bash"): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command },
  });
}

describe("the steer table", () => {
  test("every row and every owner command matches its own words, with and without arguments", () => {
    for (const row of STEER_ROWS) {
      expect(matchSteer([...row.argv])).toEqual({ kind: "steer", row });
      expect(matchSteer([...row.argv, "--flag", "x"])).toEqual({ kind: "steer", row });
    }
    for (const command of OWNER_COMMANDS) {
      expect(matchSteer([...command])).toEqual({ kind: "owner", command });
      expect(matchSteer([...command, "cap_1"])).toEqual({ kind: "owner", command });
    }
  });

  test("the program may be named by a path or with .exe; later words are exact", () => {
    expect(matchSteer(["/usr/local/bin/nimbus", "approvals"])?.kind).toBe("owner");
    expect(matchSteer(["C:\\Program Files\\Nimbus\\nimbus.exe", "captures", "list"])?.kind).toBe(
      "owner",
    ); // cross-platform-ok
    expect(matchSteer(["NIMBUS.EXE", "approvals"])?.kind).toBe("owner");
    expect(matchSteer(["/opt/bin/gh", "pr", "merge", "1"])?.kind).toBe("steer");
  });

  test("a neighbouring command is not matched", () => {
    for (const words of [
      ["gh", "pr", "view", "1"],
      ["gh", "pr"],
      ["gh"],
      [],
      ["nimbus", "approvalsx"],
      ["nimbus", "connector", "list"],
      ["nimbus", "connector"],
      ["nimbus", "ask", "approvals"],
      ["nimbusx", "approvals"],
      ["kubectl", "get", "pods"],
      ["kubectl", "rollout", "status"],
      ["terraform", "plan"],
      ["echo", "gh", "pr", "merge"],
    ]) {
      expect(matchSteer(words), words.join(" ")).toBeUndefined();
    }
  });

  test("the version is a positive integer and the table has no duplicate command", () => {
    expect(Number.isInteger(STEER_TABLE_VERSION) && STEER_TABLE_VERSION > 0).toBe(true);
    const keys = [
      ...STEER_ROWS.map((r) => r.argv.join(" ")),
      ...OWNER_COMMANDS.map((c) => c.join(" ")),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the instruction text names every row, every owner command and the bounds", () => {
    const text = renderInstructions();
    for (const row of STEER_ROWS) {
      expect(text).toContain(`\`${row.argv.join(" ")}\``);
      expect(text).toContain(`\`${row.actionType}\``);
    }
    for (const command of OWNER_COMMANDS) expect(text).toContain(`\`${command.join(" ")}\``);
    expect(text).toContain("describe_actions");
    expect(text).toContain(AGENT_DOOR_BOUNDS);
    expect(text).toContain("can still approve its own proposals");
  });
});

describe("decideCommand", () => {
  test("a steered command is denied with the action type to propose instead", () => {
    expect(decideCommand("gh pr merge 12 --squash")).toEqual({
      decision: "deny",
      reason: steerReason("github.pr.merge"),
    });
    expect(steerReason("github.pr.merge")).toContain(
      "propose_action tool with type github.pr.merge",
    );
  });

  test("an owner command is denied for every subcommand", () => {
    for (const c of [
      "nimbus approvals",
      "nimbus approvals cap_1",
      "nimbus approvals list --json",
      "nimbus approvals cap_1 --decline",
      "nimbus connector writes enable github --door agent",
      "nimbus captures accept cap_1",
    ]) {
      expect(decideCommand(c), c).toEqual({ decision: "deny", reason: OWNER_COMMAND_REASON });
    }
  });

  test("any part of a compound command is checked", () => {
    for (const c of [
      "cd repo && gh pr merge 1",
      "true || kubectl apply -f x.yaml",
      "git status; terraform apply",
      "echo hi | nimbus approvals",
      "sleep 1 & nimbus captures",
      "ls\nnimbus approvals cap_1",
      "make |& nimbus approvals",
    ]) {
      expect(decideCommand(c).decision, c).toBe("deny");
    }
  });

  test("leading assignments, sudo and quotes around a word do not hide the command", () => {
    for (const c of [
      "FOO=bar gh pr merge 1",
      "A=1 B=2 aws lambda invoke --function-name f out.json",
      "sudo kubectl scale deploy/web --replicas=0",
      '"nimbus" approvals',
      "'gh' pr merge 1",
      "   nimbus    approvals   ",
    ]) {
      expect(decideCommand(c).decision, c).toBe("deny");
    }
  });

  test("a separator inside quotes does not start a new command", () => {
    for (const c of [
      'git commit -m "docs: why we avoid gh pr merge; nimbus approvals is the owner\'s"',
      "git commit -m 'one; gh pr merge 1 && kubectl apply -f x'",
      'echo "a | nimbus approvals"',
      'printf "x\\n" "terraform apply & done"',
      'git log --grep="x;nimbus captures"',
    ]) {
      expect(decideCommand(c), c).toEqual({ decision: "none" });
    }
    // Outside the quotes the separator still counts.
    expect(decideCommand('echo "done"; gh pr merge 1').decision).toBe("deny");
    expect(decideCommand("echo 'a' && nimbus approvals").decision).toBe("deny");
    // An unclosed quote swallows the rest: no decision, never a throw.
    expect(decideCommand('echo "unclosed; gh pr merge 1')).toEqual({ decision: "none" });
  });

  test("stated bound: a line of a here-document that starts with a steered command is read as that command", () => {
    expect(decideCommand("cat > notes.md << EOF\ngh pr merge 1\nEOF").decision).toBe("deny");
  });

  test("everything else gets no decision", () => {
    for (const c of [
      "",
      "gh pr view 1",
      "git push --force",
      "kubectl delete pod x",
      "nimbus ask 'what changed'",
      "echo gh pr merge",
      "grep -r 'nimbus approvals' docs",
    ]) {
      expect(decideCommand(c), c).toEqual({ decision: "none" });
    }
  });
});

describe("decideHook", () => {
  test("a Bash or PowerShell call with a steered command is denied", () => {
    expect(decideHook(bash("gh pr merge 1")).decision).toBe("deny");
    expect(decideHook(bash("nimbus approvals", "PowerShell")).decision).toBe("deny");
  });

  test("another tool, a missing command and any malformed input get no decision, never a throw", () => {
    const none = { decision: "none" } as const;
    for (const input of [
      bash("gh pr merge 1", "Edit"),
      bash("gh pr merge 1", "mcp__nimbus__propose_action"),
      JSON.stringify({ tool_name: "Bash" }),
      JSON.stringify({ tool_name: "Bash", tool_input: null }),
      JSON.stringify({ tool_name: "Bash", tool_input: { command: 42 } }),
      JSON.stringify({ tool_name: 7, tool_input: { command: "gh pr merge 1" } }),
      JSON.stringify(["Bash"]),
      "null",
      "42",
      "",
      "not json {",
    ]) {
      expect(decideHook(input), input).toEqual(none);
    }
  });

  test("the answer is Claude Code's documented deny shape, or nothing at all", () => {
    expect(hookOutput({ decision: "none" })).toBe("");
    const out = hookOutput({ decision: "deny", reason: 'why "quoted"' });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: 'why "quoted"',
      },
    });
  });

  test("the hook imports only the steer table: no gateway, no file system, no environment", () => {
    const imports = (file: string): string[] =>
      [...readFileSync(join(import.meta.dir, file), "utf8").matchAll(/from "([^"]+)"/g)].map(
        (m) => m[1] ?? "",
      );
    expect(imports("hook.ts")).toEqual(["./steer-table.ts"]);
    expect(imports("steer-table.ts")).toEqual(["../lib/agent-door-bounds.ts"]);
    expect(readFileSync(join(import.meta.dir, "hook.ts"), "utf8")).not.toMatch(
      /process\.|Bun\.|node:/,
    );
  });
});
