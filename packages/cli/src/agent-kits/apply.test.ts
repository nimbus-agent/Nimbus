import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPlan, backupStamp, NODE_APPLY_FS, pendingEdits } from "./apply.ts";
import { codedError, fakeMachine, HOME } from "./fake-env.test-helpers.ts";
import type { FileEdit, KitPlan } from "./kit-types.ts";
import { planKit } from "./kits/index.ts";
import { nodeKitEnv } from "./production.ts";

const AT = new Date("2026-11-15T20:15:09.123Z");

function plan(files: FileEdit[]): KitPlan {
  return { kit: "codex", scope: "user", files, manual: [], enforcement: "rules", notes: [] };
}

function edit(path: string, before: string | null, after: string): FileEdit {
  return { path, component: "mcp", before, after, present: before !== null };
}

describe("backupStamp", () => {
  test("is UTC, sortable and valid in a file name", () => {
    expect(backupStamp(AT)).toBe("20261115T201509Z");
    expect(backupStamp(new Date(0))).toBe("19700101T000000Z");
  });
});

describe("pendingEdits", () => {
  test("a new file and a changed file are pending; an unchanged one and a line-ending-only difference are not", () => {
    const edits = [
      edit("a", null, "x\n"),
      edit("b", "x\n", "y\n"),
      edit("c", "x\n", "x\n"),
      edit("d", "x\r\ny\r\n", "x\ny\n"),
    ];
    expect(pendingEdits(plan(edits)).map((e) => e.path)).toEqual(["a", "b"]);
  });
});

describe("applyPlan on an in-memory machine", () => {
  const A = join(HOME, "a.json");
  const B = join(HOME, "b.json");

  test("a new file is created with no backup; a changed one keeps the old bytes in a timestamped backup", async () => {
    const m = fakeMachine({ [B]: "old\n" });
    const result = await applyPlan(
      plan([edit(A, null, "new a\n"), edit(B, "old\n", "new b\n")]),
      m.fs,
      AT,
    );
    expect(result).toEqual({
      written: [
        { path: A, backup: undefined },
        { path: B, backup: `${B}.nimbus-bak-20261115T201509Z` },
      ],
      failure: undefined,
    });
    expect(m.files.get(A)).toBe("new a\n");
    expect(m.files.get(B)).toBe("new b\n");
    expect(m.files.get(`${B}.nimbus-bak-20261115T201509Z`)).toBe("old\n");
    expect([...m.files.keys()].some((k) => k.endsWith(".nimbus-new"))).toBe(false);
  });

  test("each install that changes a file leaves its own backup; an existing backup name is refused", async () => {
    const m = fakeMachine({ [B]: "v1\n" });
    await applyPlan(plan([edit(B, "v1\n", "v2\n")]), m.fs, AT);
    await applyPlan(plan([edit(B, "v2\n", "v3\n")]), m.fs, new Date(AT.getTime() + 1000));
    expect(m.files.get(`${B}.nimbus-bak-20261115T201509Z`)).toBe("v1\n");
    expect(m.files.get(`${B}.nimbus-bak-20261115T201510Z`)).toBe("v2\n");
    // The same second again: the backup that exists is never overwritten.
    const clash = await applyPlan(plan([edit(B, "v3\n", "v4\n")]), m.fs, AT);
    expect(clash.failure?.message).toContain("already exists; nothing was written");
    expect(m.files.get(B)).toBe("v3\n");
    expect(m.files.get(`${B}.nimbus-bak-20261115T201509Z`)).toBe("v1\n");
  });

  test("a file that changed after the plan was made is not written, and nothing after it is", async () => {
    const m = fakeMachine({ [A]: "someone else wrote this\n" });
    const result = await applyPlan(
      plan([edit(A, "what the owner was shown\n", "x\n"), edit(B, null, "never\n")]),
      m.fs,
      AT,
    );
    expect(result.written).toEqual([]);
    expect(result.failure).toEqual({
      path: A,
      message: `${A} changed after the plan was shown; nothing was written to it. Run the command again`,
    });
    expect(m.files.get(A)).toBe("someone else wrote this\n");
    expect(m.files.has(B)).toBe(false);
    // A file that appeared, and one that vanished, count as changed too.
    const appeared = await applyPlan(plan([edit(A, null, "x\n")]), m.fs, AT);
    expect(appeared.failure?.path).toBe(A);
    const gone = await applyPlan(plan([edit(B, "was here\n", "x\n")]), m.fs, AT);
    expect(gone.failure?.path).toBe(B);
  });

  test("a rename that fails while another program holds the file is retried, then succeeds", async () => {
    const m = fakeMachine({ [B]: "old\n" });
    let failures = 2;
    m.fs.renameError = () => (failures-- > 0 ? codedError("EPERM") : undefined);
    const result = await applyPlan(plan([edit(B, "old\n", "new\n")]), m.fs, AT);
    expect(result.failure).toBeUndefined();
    expect(m.fs.renames).toBe(3);
    expect(m.fs.slept).toBe(2);
    expect(m.files.get(B)).toBe("new\n");
  });

  test.each(["EBUSY", "EPERM", "EACCES"])(
    "a file held open for good (%s): five tries, the temporary file removed, the target untouched, earlier files reported",
    async (code) => {
      const m = fakeMachine({ [B]: "old\n" });
      m.fs.renameError = () => undefined;
      await applyPlan(plan([edit(A, null, "a\n")]), m.fs, AT);
      m.fs.renames = 0;
      m.fs.renameError = () => codedError(code);
      const result = await applyPlan(plan([edit(B, "old\n", "new\n")]), m.fs, AT);
      expect(m.fs.renames).toBe(5);
      expect(result.written).toEqual([]);
      expect(result.failure?.message).toBe(
        `${B} is in use by another program; it was left unchanged. Close the agent and run the command again`,
      );
      expect(m.files.get(B)).toBe("old\n");
      expect(m.files.has(`${B}.nimbus-new`)).toBe(false);
      // The backup made before the attempt stays: it is a copy, and nothing is ever deleted.
      expect(m.files.get(`${B}.nimbus-bak-20261115T201509Z`)).toBe("old\n");
    },
  );

  test("any other rename error is not retried and is reported with its text", async () => {
    const m = fakeMachine({ [B]: "old\n" });
    m.fs.renameError = () => codedError("ENOSPC");
    const result = await applyPlan(plan([edit(B, "old\n", "new\n")]), m.fs, AT);
    expect(m.fs.renames).toBe(1);
    expect(result.failure?.message).toContain("could not be replaced (ENOSPC");
    expect(m.files.get(B)).toBe("old\n");
    expect(m.files.has(`${B}.nimbus-new`)).toBe(false);
  });

  test("a failure in the second file reports the first as written, with its backup", async () => {
    const m = fakeMachine({ [A]: "a1\n", [B]: "b1\n" });
    let calls = 0;
    m.fs.renameError = () => (++calls > 1 ? codedError("ENOSPC") : undefined);
    const result = await applyPlan(
      plan([edit(A, "a1\n", "a2\n"), edit(B, "b1\n", "b2\n")]),
      m.fs,
      AT,
    );
    expect(result.written).toEqual([{ path: A, backup: `${A}.nimbus-bak-20261115T201509Z` }]);
    expect(result.failure?.path).toBe(B);
    expect(m.files.get(A)).toBe("a2\n");
    expect(m.files.get(B)).toBe("b1\n");
  });

  test("a leftover temporary file from an interrupted run does not block the next one", async () => {
    const m = fakeMachine({ [B]: "old\n", [`${B}.nimbus-new`]: "half" });
    const result = await applyPlan(plan([edit(B, "old\n", "new\n")]), m.fs, AT);
    expect(result.failure).toBeUndefined();
    expect(m.files.get(B)).toBe("new\n");
  });
});

describe("applyPlan on the real file system", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratch(): { home: string; repo: string } {
    const root = mkdtempSync(join(tmpdir(), "nimbus-agent-kit-"));
    temps.push(root);
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(join(repo, ".git"), { recursive: true });
    return { home, repo };
  }

  function envOf(dirs: { home: string; repo: string }) {
    return nodeKitEnv({
      home: dirs.home,
      cwd: dirs.repo,
      nimbus: "nimbus",
      envVar: () => undefined,
    });
  }

  test("a kit installs into directories that do not exist yet, keeps the owner's file in a backup, and a second run changes nothing", async () => {
    const dirs = scratch();
    const settings = join(dirs.home, ".cursor", "mcp.json");
    mkdirSync(join(dirs.home, ".cursor"));
    writeFileSync(settings, '{\n  "mcpServers": { "mine": { "command": "x" } }\n}\n');
    const env = envOf(dirs);
    const first = await applyPlan(planKit("cursor", env, "project"), NODE_APPLY_FS, AT);
    expect(first.failure).toBeUndefined();
    expect(readFileSync(join(dirs.repo, ".cursor", "rules", "nimbus.mdc"), "utf8")).toContain(
      "alwaysApply: true",
    );
    const user = await applyPlan(planKit("cursor", env, "user"), NODE_APPLY_FS, AT);
    expect(user.written).toEqual([
      { path: settings, backup: `${settings}.nimbus-bak-20261115T201509Z` },
    ]);
    const after = JSON.parse(readFileSync(settings, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(after.mcpServers)).toEqual(["mine", "nimbus"]);
    expect(readFileSync(`${settings}.nimbus-bak-20261115T201509Z`, "utf8")).toContain('"mine"');
    expect(readdirSync(join(dirs.home, ".cursor")).some((n) => n.endsWith(".nimbus-new"))).toBe(
      false,
    );
    expect(pendingEdits(planKit("cursor", envOf(dirs), "user"))).toEqual([]);
    expect(pendingEdits(planKit("cursor", envOf(dirs), "project"))).toEqual([]);
  });

  test("a target that is a symbolic link is refused (run only where this platform can make one)", () => {
    const dirs = scratch();
    const real = join(dirs.home, "real.json");
    const link = join(dirs.home, ".cursor", "mcp.json");
    writeFileSync(real, "{}\n");
    mkdirSync(join(dirs.home, ".cursor"));
    try {
      symlinkSync(real, link);
    } catch {
      // No privilege to create a link here (Windows without developer mode): nothing to prove.
      expect(existsSync(link)).toBe(false);
      return;
    }
    expect(() => planKit("cursor", envOf(dirs), "user")).toThrow(/is not a regular file \(link\)/);
    expect(readFileSync(real, "utf8")).toBe("{}\n");
  });
});
