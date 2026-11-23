import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { applyPlan } from "../agent-kits/apply.ts";
import { fakeMachine, HOME, REPO } from "../agent-kits/fake-env.test-helpers.ts";
import { type AgentCmdDeps, parseAgentArgs, runAgentWith } from "./agent.ts";

function setup(over: { answer?: string } = {}) {
  const m = fakeMachine();
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const deps: AgentCmdDeps = {
    env: () => m.env,
    tty: { stdin: true, stdout: true },
    ask: (q) => {
      asked.push(q);
      return Promise.resolve(over.answer ?? "yes");
    },
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    apply: (plan) => applyPlan(plan, m.fs, new Date(0)),
    versionOf: () => Promise.resolve("v"),
    gatewayAnswers: () => Promise.resolve(true),
    readStdin: () => Promise.resolve(""),
  };
  return { m, deps, out, err, asked };
}

const text = (l: string[]): string => l.join("");

describe("nimbus agent uninstall", () => {
  test("parses like install: one kit, --scope, --dry-run, --yes", () => {
    expect(parseAgentArgs(["uninstall", "codex", "--dry-run", "--yes", "--scope", "user"])).toEqual(
      { verb: "uninstall", kit: "codex", scope: "user", dryRun: true, yes: true },
    );
    expect(parseAgentArgs(["uninstall"])).toBeUndefined();
    expect(parseAgentArgs(["uninstall", "nope"])).toBeUndefined();
  });

  test("shows every change with its diff, asks, deletes with backups; status then says not installed", async () => {
    const h = setup();
    expect(await runAgentWith(["install", "codex"], h.deps)).toBe(0);
    h.out.length = 0;
    h.asked.length = 0;
    expect(await runAgentWith(["uninstall", "codex"], h.deps)).toBe(0);
    const shown = text(h.out);
    const rules = join(HOME, ".codex", "rules", "nimbus.rules");
    expect(shown).toContain("Remove the Nimbus agent kit: codex (user scope)");
    expect(shown).toContain(`Delete ${rules}`);
    expect(shown).toContain(`Change ${join(HOME, ".codex", "config.toml")}`);
    expect(shown).toContain("- [mcp_servers.nimbus]");
    expect(shown).toContain(`Deleted ${rules} (before: ${rules}.nimbus-bak-`);
    expect(h.asked).toEqual(["Type yes to write these changes: "]);
    h.out.length = 0;
    expect(await runAgentWith(["status"], h.deps)).toBe(0);
    expect(text(h.out)).toContain("No agent kit is installed.");
  });

  test("an answer other than yes writes nothing and exits 1", async () => {
    const h = setup({ answer: "y" });
    await runAgentWith(["install", "codex", "--yes"], h.deps);
    const before = new Map(h.m.files);
    expect(await runAgentWith(["uninstall", "codex"], h.deps)).toBe(1);
    expect(h.m.files).toEqual(before);
  });

  test("--dry-run neither asks nor writes", async () => {
    const h = setup();
    await runAgentWith(["install", "codex"], h.deps);
    const before = new Map(h.m.files);
    h.asked.length = 0;
    expect(await runAgentWith(["uninstall", "codex", "--dry-run"], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.m.files).toEqual(before);
    expect(text(h.out)).toContain("Dry run: nothing was written.");
  });

  test("with no terminal it refuses; --yes is the stated way past, as for install", async () => {
    const h = setup();
    await runAgentWith(["install", "codex", "--yes"], h.deps);
    const noTty = { ...h.deps, tty: { stdin: false, stdout: false } };
    expect(await runAgentWith(["uninstall", "codex"], noTty)).toBe(1);
    expect(text(h.err)).toContain("nimbus agent uninstall");
    expect(h.m.files.has(join(HOME, ".codex", "rules", "nimbus.rules"))).toBe(true);
    expect(await runAgentWith(["uninstall", "codex", "--yes"], noTty)).toBe(0);
    expect(h.m.files.has(join(HOME, ".codex", "rules", "nimbus.rules"))).toBe(false);
  });

  test("nothing installed: says so, asks nothing, exit 0", async () => {
    const h = setup();
    expect(await runAgentWith(["uninstall", "cursor", "--scope", "project"], h.deps)).toBe(0);
    expect(text(h.out)).toContain("Nothing of this kit is installed here.");
    expect(h.asked).toEqual([]);
  });

  test("an edited block is one line on stderr, exit 1, nothing asked or written", async () => {
    const h = setup();
    await runAgentWith(["install", "vscode", "--scope", "project", "--yes"], h.deps);
    const path = join(REPO, ".github", "copilot-instructions.md");
    h.m.files.set(path, (h.m.files.get(path) ?? "").replace("propose_action", "mine"));
    const before = new Map(h.m.files);
    h.asked.length = 0;
    expect(await runAgentWith(["uninstall", "vscode", "--scope", "project"], h.deps)).toBe(1);
    expect(text(h.err)).toContain("edited after Nimbus wrote it");
    expect(h.asked).toEqual([]);
    expect(h.m.files).toEqual(before);
  });

  test("Claude Code at user scope prints the one command to run for the server", async () => {
    const h = setup();
    await runAgentWith(["install", "claude-code", "--yes"], h.deps);
    h.out.length = 0;
    await runAgentWith(["uninstall", "claude-code", "--dry-run"], h.deps);
    expect(text(h.out)).toContain("  claude mcp remove --scope user nimbus");
  });
});
