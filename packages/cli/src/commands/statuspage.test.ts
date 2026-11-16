import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CliExit } from "../lib/cli-exit.ts";
import {
  parseStatuspageArgs,
  runStatuspageCommand,
  runStatuspageWith,
  STATUSPAGE_DEFAULT_FILE,
  type StatuspageIo,
  type StatuspageIpc,
} from "./statuspage.ts";
import type { StatuspagePageModel } from "./statuspage-render.ts";

const NOW = Date.UTC(2026, 10, 16, 9, 0);
const MODEL: StatuspagePageModel = {
  generatedAtMs: NOW,
  generatedAt: new Date(NOW).toISOString(),
  options: { services: [], titles: false, links: false },
  incidents: { status: "none_open", total: 0, items: [], sources: [] },
  onCall: { status: "ok", shifts: [], next: [], sources: [] },
  dora: { status: "no_services", windowDays: 30, rows: [] },
  gaps: [],
};

function fake(r: unknown): StatuspageIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nimbus-statuspage-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const io = (): StatuspageIo => ({
  cwd: dir,
  async writeFile(file, data, overwrite) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
  },
});

const ARGS = { force: false, services: [], titles: false, links: false, json: false } as const;

describe("parseStatuspageArgs", () => {
  test("defaults", () => {
    expect(parseStatuspageArgs(["draft"])).toEqual({
      force: false,
      services: [],
      titles: false,
      links: false,
      json: false,
    });
  });

  test("every flag, in both spellings, with repeatable --service", () => {
    expect(
      parseStatuspageArgs([
        "draft",
        "--out",
        "a.html",
        "--force",
        "--service",
        "x",
        "--service=y",
        "--title",
        "T",
        "--titles",
        "--links",
        "--json",
      ]),
    ).toEqual({
      out: "a.html",
      force: true,
      services: ["x", "y"],
      title: "T",
      titles: true,
      links: true,
      json: true,
    });
    expect(parseStatuspageArgs(["draft", "--out", "-"])?.out).toBe("-");
    expect(parseStatuspageArgs(["draft", "--out=-"])?.out).toBe("-");
  });

  test.each([
    [[]],
    [["publish"]],
    [["draft", "--nope"]],
    [["draft", "--out"]],
    [["draft", "--out", "--force"]],
    [["draft", "--out", "a", "--out", "b"]],
    [["draft", "--title", "a", "--title", "b"]],
    [["draft", "--service", " "]],
    [["draft", "--service", "-x"]],
    [["draft", "extra"]],
  ])("rejects %j", (argv) => {
    expect(parseStatuspageArgs(argv)).toBeUndefined();
  });
});

describe("runStatuspageWith", () => {
  test("writes nimbus-status.html in the cwd by default and passes the flags to the gateway", async () => {
    const c = fake(MODEL);
    const { s, sink: k } = sink();
    const code = await runStatuspageWith(c, { ...ARGS, services: ["a"], titles: true }, k, io());
    expect(code).toBe(0);
    expect(c.calls).toEqual([
      ["statuspage.model", { services: ["a"], titles: true, links: false }],
    ]);
    const file = path.join(dir, STATUSPAGE_DEFAULT_FILE);
    expect(readFileSync(file, "utf8")).toContain("Review before publishing.");
    expect(s.out).toContain(file);
    expect(s.out).toContain("does not upload");
  });

  test("refuses to overwrite an existing file, and --force overwrites it", async () => {
    const file = path.join(dir, STATUSPAGE_DEFAULT_FILE);
    writeFileSync(file, "mine");
    const a = sink();
    expect(await runStatuspageWith(fake(MODEL), ARGS, a.sink, io())).toBe(1);
    expect(a.s.err).toContain("already exists");
    expect(readFileSync(file, "utf8")).toBe("mine");
    const b = sink();
    expect(await runStatuspageWith(fake(MODEL), { ...ARGS, force: true }, b.sink, io())).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("<!doctype html>");
  });

  test("--out names a file (relative to the cwd) and creates its directory", async () => {
    const { sink: k } = sink();
    const a = { ...ARGS, out: path.join("sub", "p.html"), title: "Acme status" };
    expect(await runStatuspageWith(fake(MODEL), a, k, io())).toBe(0);
    expect(readFileSync(path.join(dir, "sub", "p.html"), "utf8")).toContain(
      "<title>Acme status</title>",
    );
  });

  test("--out - writes the page to stdout and creates no file", async () => {
    const { s, sink: k } = sink();
    expect(await runStatuspageWith(fake(MODEL), { ...ARGS, out: "-" }, k, io())).toBe(0);
    expect(s.out.startsWith("<!doctype html>")).toBe(true);
    expect(s.err).toContain("stdout");
    expect(() => readFileSync(path.join(dir, STATUSPAGE_DEFAULT_FILE))).toThrow();
  });

  test("--json prints the model and writes no file", async () => {
    const { s, sink: k } = sink();
    expect(await runStatuspageWith(fake(MODEL), { ...ARGS, json: true }, k, io())).toBe(0);
    expect(JSON.parse(s.out)).toEqual(MODEL);
    expect(() => readFileSync(path.join(dir, STATUSPAGE_DEFAULT_FILE))).toThrow();
  });

  test("a gateway error exits 1, as JSON under --json, with control characters stripped", async () => {
    const a = sink();
    expect(await runStatuspageWith(fake(new Error("bad\u001b[31m news")), ARGS, a.sink, io())).toBe(
      1,
    );
    expect(a.s.err).toBe("bad[31m news\n");
    const b = sink();
    expect(
      await runStatuspageWith(fake(new Error("x")), { ...ARGS, json: true }, b.sink, io()),
    ).toBe(1);
    expect(JSON.parse(b.s.out)).toEqual({ error: "x" });
  });

  test("a write failure other than EEXIST is reported, not swallowed", async () => {
    const a = sink();
    const failing: StatuspageIo = {
      cwd: dir,
      async writeFile() {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    expect(await runStatuspageWith(fake(MODEL), ARGS, a.sink, failing)).toBe(1);
    expect(a.s.err).toContain("disk full");
  });
});

describe("runStatuspageCommand", () => {
  test("bad arguments print the usage and exit 1 without touching the gateway", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let seen = "";
    process.stderr.write = ((s: string) => {
      seen += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(runStatuspageCommand(["publish"])).rejects.toBeInstanceOf(CliExit);
    } finally {
      process.stderr.write = orig;
    }
    expect(seen).toContain("Usage: nimbus statuspage draft");
  });
});
