import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import {
  type PostmortemFs,
  parsePostmortemArgs,
  realPostmortemFs,
  runPostmortemCommand,
  runPostmortemWith,
  safeText,
} from "./incident-postmortem.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(replies: Record<string, unknown | ((p: unknown) => unknown)>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "session.declareKind") return {};
      const r = replies[method];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? (r as (p: unknown) => unknown)(params) : r;
    },
  };
  return {
    out,
    err,
    calls,
    ipc: ipc as unknown as Pick<IPCClient, "call">,
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

function memFs(files: Record<string, string> = {}) {
  const written: { path: string; text: string; exclusive: boolean }[] = [];
  const fs: PostmortemFs = {
    readText: (path) => {
      const t = files[path];
      if (t === undefined) throw new Error("ENOENT");
      return t;
    },
    writeText: (path, text, exclusive) => {
      if (exclusive && Object.hasOwn(files, path)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      files[path] = text;
      written.push({ path, text, exclusive });
    },
  };
  return { fs, files, written };
}

const DRAFT = {
  recordId: "inc_0123456789abcdef",
  version: 2,
  markdown: "# Post-mortem: x\n",
  synthesis: null,
};

describe("parsePostmortemArgs", () => {
  test("draft forms", () => {
    expect(parsePostmortemArgs(["inc_1"])).toEqual({
      mode: "draft",
      id: "inc_1",
      json: false,
      force: false,
      synthesize: false,
    });
    expect(
      parsePostmortemArgs([
        "inc_1",
        "--out",
        "a.md",
        "--force",
        "--template",
        "t.md",
        "--synthesize",
        "--json",
      ]),
    ).toEqual({
      mode: "draft",
      id: "inc_1",
      json: true,
      force: true,
      synthesize: true,
      out: "a.md",
      template: "t.md",
    });
  });

  test("push forms", () => {
    expect(parsePostmortemArgs(["inc_1", "--push", "notion", "--parent", "abc"])).toEqual({
      mode: "push",
      id: "inc_1",
      target: "notion",
      parent: "abc",
    });
    expect(
      parsePostmortemArgs([
        "inc_1",
        "--push",
        "confluence",
        "--space",
        "ENG",
        "--parent",
        "9",
        "--file",
        "f.md",
        "--title",
        "T",
      ]),
    ).toEqual({
      mode: "push",
      id: "inc_1",
      target: "confluence",
      space: "ENG",
      parent: "9",
      file: "f.md",
      title: "T",
    });
  });

  test("usage errors: duplicates, missing values, mixed modes, missing ids, unknown flags", () => {
    const bad: string[][] = [
      [],
      ["--json"],
      ["a", "b"],
      ["a", "--nope"],
      ["a", "--out"],
      ["a", "--out", "--force"],
      ["a", "--out", "x", "--out", "y"],
      ["a", "--force", "--force"],
      ["a", "--parent", "x"],
      ["a", "--push", "slack"],
      ["a", "--push", "notion"],
      ["a", "--push", "notion", "--parent", "p", "--space", "S"],
      ["a", "--push", "confluence"],
      ["a", "--push", "notion", "--parent", "p", "--synthesize"],
      ["a", "--push", "notion", "--parent", "p", "--out", "x"],
      ["a", "--push", "notion", "--parent", "p", "--json"],
    ];
    for (const argv of bad) expect(parsePostmortemArgs(argv), argv.join(" ")).toBeUndefined();
  });
});

describe("the draft", () => {
  test("is written to the default path under the data dir, once, and says what it wrote", async () => {
    const h = harness({ "incident.postmortem": DRAFT });
    const m = memFs();
    const a = parsePostmortemArgs(["inc_1"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: m.fs })).toBe(0);
    expect(m.written).toEqual([
      {
        path: join("D", "postmortems", "inc_0123456789abcdef.md"),
        text: DRAFT.markdown,
        exclusive: true,
      },
    ]);
    expect(h.out.join("")).toContain("(record version 2)");
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.postmortem"]);
    expect(h.calls[1]?.params).toEqual({ id: "inc_1" });
    expect(h.err).toEqual([]);
  });

  test("never overwrites an edited draft without --force", async () => {
    const h = harness({ "incident.postmortem": DRAFT });
    const path = join("D", "postmortems", "inc_0123456789abcdef.md");
    const m = memFs({ [path]: "my edits" });
    const a = parsePostmortemArgs(["inc_1"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: m.fs })).toBe(1);
    expect(m.files[path]).toBe("my edits");
    expect(h.err.join("")).toContain("already exists; pass --force");
    const f = parsePostmortemArgs(["inc_1", "--force"]);
    if (f === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, f, h.sink, { dataDir: "D", fs: m.fs })).toBe(0);
    expect(m.files[path]).toBe(DRAFT.markdown);
  });

  test("--out names the file; --template is read and sent; --synthesize is sent", async () => {
    const h = harness({ "incident.postmortem": DRAFT });
    const m = memFs({ "t.md": "{{summary}}" });
    const a = parsePostmortemArgs(["inc_1", "--out", "o.md", "--template", "t.md", "--synthesize"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: m.fs })).toBe(0);
    expect(h.calls[1]?.params).toEqual({ id: "inc_1", template: "{{summary}}", synthesize: true });
    expect(m.written[0]?.path).toBe("o.md");
  });

  test("a missing template file is an error and the gateway is never asked", async () => {
    const h = harness({ "incident.postmortem": DRAFT });
    const a = parsePostmortemArgs(["inc_1", "--template", "nope.md"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: memFs().fs })).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain("ENOENT");
  });

  test("--json prints the reply and writes nothing", async () => {
    const h = harness({ "incident.postmortem": DRAFT });
    const m = memFs();
    const a = parsePostmortemArgs(["inc_1", "--json"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: m.fs })).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual(DRAFT);
    expect(m.written).toEqual([]);
  });

  test("the model's fate is printed on stderr, stripped of control characters", async () => {
    const cases: [unknown, RegExp][] = [
      [{ attempted: true, used: true, model: "m\u001b[31m" }, /rewritten by m \[31m/],
      [
        { attempted: true, used: false, reason: "contract_violation" },
        /not used \(contract_violation\)/,
      ],
      [{ attempted: false, reason: "disabled" }, /No model was used \(disabled\)/],
    ];
    for (const [synthesis, re] of cases) {
      const h = harness({ "incident.postmortem": { ...DRAFT, synthesis } });
      const a = parsePostmortemArgs(["inc_1", "--synthesize"]);
      if (a === undefined) throw new Error("usage");
      await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: memFs().fs });
      const e = h.err.join("");
      expect(e).toMatch(re);
      expect(e).not.toContain("\u001b");
    }
  });

  test("a gateway error is printed once, stripped, and exits 1", async () => {
    const h = harness({
      "incident.postmortem": new Error("ERR_POSTMORTEM_NOT_RESOLVED: x\u001b[2J\u202e"),
    });
    const a = parsePostmortemArgs(["inc_1"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: memFs().fs })).toBe(1);
    expect(h.err.join("")).toBe("ERR_POSTMORTEM_NOT_RESOLVED: x [2J\n");
  });

  test("an unexpected write error is reported, not swallowed", async () => {
    const h = harness({ "incident.postmortem": DRAFT });
    const fs: PostmortemFs = {
      readText: () => "",
      writeText: () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const a = parsePostmortemArgs(["inc_1"]);
    if (a === undefined) throw new Error("usage");
    expect(await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs })).toBe(1);
    expect(h.err.join("")).toContain("disk full");
  });
});

describe("the push", () => {
  const get = { record: { summary: { id: "inc_0123456789abcdef" } } };
  const path = join("D", "postmortems", "inc_0123456789abcdef.md");

  async function push(
    reply: unknown,
    argv = ["inc_1", "--push", "confluence", "--space", "ENG"],
    files: Record<string, string> = { [path]: "# T\nbody" },
    record: unknown = get,
  ) {
    const h = harness({ "incident.get": record, "incident.postmortemPush": reply });
    const a = parsePostmortemArgs(argv);
    if (a === undefined) throw new Error("usage");
    const code = await runPostmortemWith(h.ipc, a, h.sink, { dataDir: "D", fs: memFs(files).fs });
    return { h, code };
  }

  test("reads the default draft, sends it with the target and reports the page", async () => {
    const { h, code } = await push({ outcome: "pushed", pageId: "55" });
    expect(code).toBe(0);
    const sent = h.calls.find((c) => c.method === "incident.postmortemPush");
    expect(sent?.params).toEqual({
      id: "inc_1",
      target: "confluence",
      markdown: "# T\nbody",
      space: "ENG",
    });
    expect(h.out.join("")).toBe("Pushed. The page id is 55.\n");
  });

  test("--file, --parent and --title are sent; a null page id still reports success", async () => {
    const { h, code } = await push(
      { outcome: "pushed", pageId: null },
      ["inc_1", "--push", "notion", "--parent", "p", "--file", "mine.md", "--title", "Mine"],
      { "mine.md": "# X\nb" },
    );
    expect(code).toBe(0);
    expect(h.calls.find((c) => c.method === "incident.postmortemPush")?.params).toEqual({
      id: "inc_1",
      target: "notion",
      markdown: "# X\nb",
      parent: "p",
      title: "Mine",
    });
    expect(h.out.join("")).toBe("Pushed. The page was created.\n");
  });

  test("refused and denied push exit 1 and say nothing was written", async () => {
    const refused = await push({
      outcome: "refused",
      code: "ERR_POSTMORTEM_PUSH_REFUSED",
      reason: "r\u001b[1m",
    });
    expect(refused.code).toBe(1);
    expect(refused.h.err.join("")).toBe("Not pushed (ERR_POSTMORTEM_PUSH_REFUSED): r [1m\n");
    const denied = await push({ outcome: "denied", reason: "declined" });
    expect(denied.code).toBe(1);
    expect(denied.h.err.join("")).toBe("Not pushed: declined. Nothing was written.\n");
  });

  test("a partial Notion push names the page and what to do; an unreadable id says to look for the empty page", async () => {
    const partial = await push({
      outcome: "partial",
      code: "ERR_POSTMORTEM_PUSH_PARTIAL",
      pageId: "pg-1",
      reason: "declined",
    });
    expect(partial.code).toBe(1);
    expect(partial.h.err.join("")).toContain("created WITHOUT its body");
    expect(partial.h.err.join("")).toContain("Its id is pg-1");
    const unavailable = await push({
      outcome: "unavailable",
      code: "ERR_POSTMORTEM_PUSH_PARTIAL",
      reason: "no id",
    });
    expect(unavailable.code).toBe(1);
    expect(unavailable.h.err.join("")).toContain("Find the empty page");
  });

  test("an unknown record, or a missing draft, stops before the push call", async () => {
    const none = await push({ outcome: "pushed", pageId: "1" }, undefined, undefined, {
      record: null,
    });
    expect(none.code).toBe(1);
    expect(none.h.calls.map((c) => c.method)).not.toContain("incident.postmortemPush");
    const noFile = await push({ outcome: "pushed", pageId: "1" }, undefined, {});
    expect(noFile.code).toBe(1);
    expect(noFile.h.err.join("")).toContain("Draft it first");
    expect(noFile.h.calls.map((c) => c.method)).not.toContain("incident.postmortemPush");
  });

  test("the command offers no way to answer the approval for you", () => {
    expect(
      parsePostmortemArgs(["a", "--push", "notion", "--parent", "p", "--yes"]),
    ).toBeUndefined();
    expect(parsePostmortemArgs(["a", "--yes"])).toBeUndefined();
  });
});

describe("the real file system", () => {
  test("creates the directory 0700-ish and the file 0600, refuses to replace, and caps reads", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-pm-"));
    dirs.push(root);
    const file = join(root, "sub", "d.md");
    realPostmortemFs.writeText(file, "hello", true);
    expect(readFileSync(file, "utf8")).toBe("hello");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => realPostmortemFs.writeText(file, "again", true)).toThrow();
    realPostmortemFs.writeText(file, "forced", false);
    expect(realPostmortemFs.readText(file, 100)).toBe("forced");
    writeFileSync(join(root, "big.md"), "x".repeat(50));
    expect(() => realPostmortemFs.readText(join(root, "big.md"), 10)).toThrow(
      /larger than 10 bytes/,
    );
  });
});

describe("safeText and the entry point", () => {
  test("removes control, bidi and separator characters", () => {
    expect(safeText("a\u001b[0m\u202eb\u2028c\u200bd")).toBe("a [0m b c d");
  });

  test("a usage error prints the usage and exits 1", async () => {
    let caught: unknown;
    try {
      await runPostmortemCommand(["--bogus"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliExit);
    expect((caught as CliExit).code).toBe(1);
  });
});
