import { describe, expect, spyOn, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import {
  PRE_REVIEW_USAGE,
  type PreReviewSink,
  parsePreReviewArgs,
  runPreReviewCommand,
  runPreReviewWith,
} from "./pre-review.ts";

function sink(): PreReviewSink & { stdout: string; stderr: string } {
  const s = {
    stdout: "",
    stderr: "",
    out(x: string) {
      s.stdout += x;
    },
    err(x: string) {
      s.stderr += x;
    },
  };
  return s;
}

type Call = { method: string; params: unknown };

function client(reply: unknown | Error, calls: Call[] = []): Pick<IPCClient, "call"> {
  return {
    call: (async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "prreview.run") {
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return { ok: true };
    }) as IPCClient["call"],
  };
}

describe("parsePreReviewArgs", () => {
  test("one URL and the two flags", () => {
    expect(parsePreReviewArgs(["https://x/pull/1"])).toEqual({
      url: "https://x/pull/1",
      json: false,
    });
    expect(parsePreReviewArgs(["https://x/pull/1", "--json"])).toEqual({
      url: "https://x/pull/1",
      json: true,
    });
  });

  test("usage errors", () => {
    for (const bad of [
      [],
      ["--json"],
      ["a", "b"],
      ["a", "--yes"],
      ["a", "--json", "--json"],
      ["a", "--synthesize"],
    ]) {
      expect(parsePreReviewArgs(bad)).toBeUndefined();
    }
  });
});

describe("runPreReviewWith", () => {
  test("declares the CLI kind, calls prreview.run and prints the brief", async () => {
    const calls: Call[] = [];
    const s = sink();
    const code = await runPreReviewWith(
      client({ markdown: "# Pre-review: x\n\nbody" }, calls),
      { url: "https://x/pull/1", json: false },
      s,
    );
    expect(code).toBe(0);
    expect(calls.at(-1)).toEqual({ method: "prreview.run", params: { url: "https://x/pull/1" } });
    expect(calls.length).toBeGreaterThan(1);
    expect(s.stdout).toBe("# Pre-review: x\n\nbody\n");
    expect(s.stderr).toBe("");
  });

  test("--json prints the raw reply", async () => {
    const s = sink();
    const reply = { markdown: "m", brief: { kind: "pr_prereview" } };
    expect(await runPreReviewWith(client(reply), { url: "u", json: true }, s)).toBe(0);
    expect(JSON.parse(s.stdout)).toEqual(reply);
  });

  test("control and invisible characters are stripped from what is printed", async () => {
    const s = sink();
    await runPreReviewWith(
      client({ markdown: `a\u001b[31mred\u202eb\nline2` }),
      { url: "u", json: false },
      s,
    );
    expect(s.stdout).toBe("a [31mred b\nline2\n");
  });

  test("a gateway error is printed and exits 1", async () => {
    const s = sink();
    const code = await runPreReviewWith(
      client(new Error("ERR_PREREVIEW_UNRESOLVED: not indexed\u001b")),
      { url: "u", json: false },
      s,
    );
    expect(code).toBe(1);
    expect(s.stderr).toBe("ERR_PREREVIEW_UNRESOLVED: not indexed\n");
  });
});

describe("runPreReviewCommand", () => {
  test("a missing URL prints the usage and exits 2 before any connection", async () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const e = await runPreReviewCommand([]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CliExit);
      expect((e as CliExit).code).toBe(2);
      expect(spy).toHaveBeenCalledWith(`${PRE_REVIEW_USAGE}\n`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runPreReviewWith, non-Error failures", () => {
  test("a thrown string is printed", async () => {
    const s = sink();
    const c: Pick<IPCClient, "call"> = {
      call: (async (method: string) => {
        if (method === "prreview.run") throw "plain failure";
        return { ok: true };
      }) as IPCClient["call"],
    };
    expect(await runPreReviewWith(c, { url: "u", json: false }, s)).toBe(1);
    expect(s.stderr).toBe("plain failure\n");
  });
});
