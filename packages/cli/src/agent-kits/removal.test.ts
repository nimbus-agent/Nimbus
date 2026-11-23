import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { applyPlan } from "./apply.ts";
import { fakeMachine, HOME, REPO } from "./fake-env.test-helpers.ts";
import { KIT_IDS, type KitId, type KitScope } from "./kit-types.ts";
import { planKit, SUPPORTED_SCOPES } from "./kits/index.ts";
import { KitRefusal, removeBlock, renderBlock, upsertBlock } from "./plan-files.ts";
import { planKitRemoval } from "./removal.ts";
import { kitStatus } from "./status.ts";

type Machine = ReturnType<typeof fakeMachine>;

async function install(m: Machine, kit: KitId, scope: KitScope): Promise<void> {
  expect((await applyPlan(planKit(kit, m.env, scope), m.fs, new Date(0))).failure).toBeUndefined();
}

async function uninstall(m: Machine, kit: KitId, scope: KitScope): Promise<void> {
  const plan = planKitRemoval(kit, m.env, scope);
  const r = await applyPlan(plan, m.fs, new Date(1000));
  expect(r.failure).toBeUndefined();
}

const CASES: [KitId, KitScope][] = KIT_IDS.flatMap((kit) =>
  SUPPORTED_SCOPES[kit].map((scope): [KitId, KitScope] => [kit, scope]),
);

describe("removeBlock", () => {
  const kit = "codex";
  test("is the reverse of upsertBlock, byte for byte, for LF and CRLF files", () => {
    for (const original of ["a = 1\n", "a = 1\r\nb = 2\r\n", "# hi\n\n# there\n"]) {
      const withBlock = upsertBlock(original, kit, 1, "body", "hash");
      expect(removeBlock(withBlock, kit, "hash", "f")).toBe(original);
    }
  });

  test("a file that held only the block comes out empty; no block is undefined", () => {
    expect(removeBlock(upsertBlock(null, kit, 1, "x", "hash"), kit, "hash", "f")).toBe("");
    expect(removeBlock("a = 1\n", kit, "hash", "f")).toBeUndefined();
  });

  test("a block in the middle leaves the text above and below it", () => {
    const text = `top\n\n${renderBlock(kit, 1, "body", "hash")}\n\nbottom\n`;
    expect(removeBlock(text, kit, "hash", "f")).toBe("top\n\nbottom\n");
  });

  test("an edited block is refused, naming the file and how to finish by hand", () => {
    const edited = upsertBlock(null, kit, 1, "body", "hash").replace("body", "my own line");
    expect(() => removeBlock(edited, kit, "hash", "/x/config.toml")).toThrow(
      /\/x\/config\.toml.*edited after Nimbus wrote it.*by hand/,
    );
  });

  test("a block with no end is refused, never half-removed", () => {
    const text = `${renderBlock(kit, 1, "body", "hash").split("\n").slice(0, 2).join("\n")}\n`;
    expect(() => removeBlock(text, kit, "hash", "f")).toThrow(KitRefusal);
  });
});

describe("planKitRemoval", () => {
  test.each(CASES)(
    "%s at %s scope: install then uninstall leaves status not installed",
    async (kit, scope) => {
      const m = fakeMachine();
      await install(m, kit, scope);
      expect(kitStatus(kit, m.env, scope).installed).toBe(true);
      await uninstall(m, kit, scope);
      expect(kitStatus(kit, m.env, scope).installed).toBe(false);
    },
  );

  test.each(CASES)("%s at %s scope: nothing installed means nothing to do", (kit, scope) => {
    expect(planKitRemoval(kit, fakeMachine().env, scope).files).toEqual([]);
  });

  test("the owner's own lines and keys survive an install and an uninstall", async () => {
    const settings = join(HOME, ".claude", "settings.json");
    const own = {
      model: "x",
      permissions: { deny: ["Bash(rm *)"], allow: ["Read"] },
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }] },
    };
    const m = fakeMachine({ [settings]: `${JSON.stringify(own, null, 2)}\n` });
    await install(m, "claude-code", "user");
    await uninstall(m, "claude-code", "user");
    expect(JSON.parse(m.files.get(settings) ?? "")).toEqual(own);

    const agents = join(HOME, ".codex", "AGENTS.md");
    const config = join(HOME, ".codex", "config.toml");
    const m2 = fakeMachine({ [agents]: "# my notes\n", [config]: 'model = "o"\n' });
    await install(m2, "codex", "user");
    await uninstall(m2, "codex", "user");
    expect(m2.files.get(agents)).toBe("# my notes\n");
    expect(m2.files.get(config)).toBe('model = "o"\n');
  });

  test("every changed file is backed up first, and a Nimbus-named file that held only the kit is deleted", async () => {
    const m = fakeMachine();
    await install(m, "codex", "user");
    await uninstall(m, "codex", "user");
    const rules = join(HOME, ".codex", "rules", "nimbus.rules");
    const config = join(HOME, ".codex", "config.toml");
    expect(m.files.has(rules)).toBe(false);
    expect(m.files.get(config)).toBe("");
    for (const p of [rules, config, join(HOME, ".codex", "AGENTS.md")]) {
      expect(m.files.has(`${p}.nimbus-bak-19700101T000001Z`)).toBe(true);
    }
    const c = fakeMachine();
    await install(c, "cursor", "project");
    await uninstall(c, "cursor", "project");
    expect(c.files.has(join(REPO, ".cursor", "rules", "nimbus.mdc"))).toBe(false);
  });

  test("a reinstall after an uninstall works (a deleted Nimbus-named file does not block it)", async () => {
    const m = fakeMachine();
    await install(m, "cursor", "project");
    await uninstall(m, "cursor", "project");
    await install(m, "cursor", "project");
    expect(kitStatus("cursor", m.env, "project").installed).toBe(true);
  });

  test("a hook group that also holds the owner's handler keeps it", async () => {
    const settings = join(HOME, ".claude", "settings.json");
    const m = fakeMachine();
    await install(m, "claude-code", "user");
    const parsed = JSON.parse(m.files.get(settings) ?? "") as {
      hooks: { PreToolUse: { hooks: unknown[] }[] };
    };
    parsed.hooks.PreToolUse[0]?.hooks.push({ type: "command", command: "mine" });
    m.files.set(settings, JSON.stringify(parsed, null, 2));
    await uninstall(m, "claude-code", "user");
    const after = JSON.parse(m.files.get(settings) ?? "") as typeof parsed;
    expect(after.hooks.PreToolUse[0]?.hooks).toEqual([{ type: "command", command: "mine" }]);
  });

  test("a server entry Nimbus did not write is left, with a note", () => {
    const mcp = join(REPO, ".mcp.json");
    const foreign = { mcpServers: { nimbus: { command: "other", args: ["serve"] } } };
    const m = fakeMachine({ [mcp]: JSON.stringify(foreign) });
    const plan = planKitRemoval("claude-code", m.env, "project");
    expect(plan.files).toEqual([]);
    expect(plan.notes.join("\n")).toContain("not one Nimbus wrote");
  });

  test("an edited block refuses the whole uninstall and writes nothing", async () => {
    const m = fakeMachine();
    await install(m, "codex", "user");
    const agents = join(HOME, ".codex", "AGENTS.md");
    m.files.set(agents, (m.files.get(agents) ?? "").replace("propose_action", "MY EDIT"));
    const before = new Map(m.files);
    expect(() => planKitRemoval("codex", m.env, "user")).toThrow(/edited after Nimbus wrote it/);
    expect(m.files).toEqual(before);
  });

  test("a JSON file that is not strict JSON is refused, never rewritten", () => {
    const mcp = join(REPO, ".mcp.json");
    const m = fakeMachine({ [mcp]: '{ // note\n "mcpServers": {} }' });
    expect(() => planKitRemoval("claude-code", m.env, "project")).toThrow(/not strict JSON/);
  });

  test("a link at a managed file is refused, as it is for install", () => {
    const mcp = join(REPO, ".mcp.json");
    const m = fakeMachine({ [mcp]: "{}" });
    m.links.add(mcp);
    expect(() => planKitRemoval("claude-code", m.env, "project")).toThrow(KitRefusal);
  });

  test("a foreign [mcp_servers.nimbus] table outside the block is untouched", () => {
    const config = join(HOME, ".codex", "config.toml");
    const foreign = '[mcp_servers.nimbus]\ncommand = "mine"\n';
    const m = fakeMachine({ [config]: foreign });
    expect(planKitRemoval("codex", m.env, "user").files).toEqual([]);
  });

  test("Claude Code at user scope names the one command the owner runs for the server", () => {
    const plan = planKitRemoval("claude-code", fakeMachine().env, "user");
    expect(plan.manual.map((s) => s.argv.join(" "))).toEqual([
      "claude mcp remove --scope user nimbus",
    ]);
  });

  test("project scope outside a repository and Codex at project scope are refused like install", () => {
    expect(() => planKitRemoval("cursor", fakeMachine({}, false).env, "project")).toThrow(
      KitRefusal,
    );
    expect(() => planKitRemoval("codex", fakeMachine().env, "project")).toThrow(KitRefusal);
  });
});

describe("applying a removal", () => {
  async function codexRulesFailure(code: string): Promise<string | undefined> {
    const m = fakeMachine();
    await install(m, "codex", "user");
    const rules = join(HOME, ".codex", "rules", "nimbus.rules");
    const plan = planKitRemoval("codex", m.env, "user");
    const fs = {
      ...m.fs,
      remove: (p: string) => {
        if (p === rules) throw Object.assign(new Error(`${code}: no`), { code });
        m.fs.remove(p);
      },
    };
    const r = await applyPlan(plan, fs, new Date(1000));
    // The file is still there: the delete failed after the backup was made.
    expect(m.files.has(rules)).toBe(true);
    return r.failure?.message;
  }

  test("a file another program holds is left in place, with a message that says so", async () => {
    expect(await codexRulesFailure("EBUSY")).toContain("is in use by another program");
  });

  test("any other delete failure is reported and the file is left in place", async () => {
    expect(await codexRulesFailure("EIO")).toContain("could not be deleted");
  });
});
