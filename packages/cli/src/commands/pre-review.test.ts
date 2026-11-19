import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { parsePreReviewArgs, type PreReviewSink, runPreReviewWith } from "./pre-review.ts";

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
      synthesize: false,
    });
    expect(parsePreReviewArgs(["https://x/pull/1", "--json", "--synthesize"])).toEqual({
      url: "https://x/pull/1",
      json: true,
      synthesize: true,
    });
  });

  test("usage errors", () => {
    for (const bad of [[], ["--json"], ["a", "b"], ["a", "--yes"], ["a", "--json", "--json"]]) {
      expect(parsePreReviewArgs(bad)).toBeUndefined();
    }
  });
});

describe("runPreReviewWith", () => {
  test("declares the CLI kind, calls prreview.run and prints the brief", async () => {
    const calls: Call[] = [];
    const s = sink();
    const code = await runPreReviewWith(
      client({ markdown: "# Pre-review: x\n\nbody", synthesis: null }, calls),
      { url: "https://x/pull/1", json: false, synthesize: false },
      s,
    );
    expect(code).toBe(0);
    expect(calls.at(-1)).toEqual({ method: "prreview.run", params: { url: "https://x/pull/1" } });
    expect(calls.length).toBeGreaterThan(1);
    expect(s.stdout).toBe("# Pre-review: x\n\nbody\n");
    expect(s.stderr).toBe("");
  });

  test("--synthesize is sent and the outcome is noted on stderr", async () => {
    const calls: Call[] = [];
    const used = sink();
    await runPreReviewWith(
      client({ markdown: "m\n", synthesis: { attempted: true, used: true, model: "local" } }, calls),
      { url: "u", json: false, synthesize: true },
      used,
    );
    expect(calls.at(-1)?.params).toEqual({ url: "u", synthesize: true });
    expect(used.stderr).toContain("Rewritten by local");
    const off = sink();
    await runPreReviewWith(
      client({ markdown: "m", synthesis: { attempted: false, reason: "disabled" } }),
      { url: "u", json: false, synthesize: true },
      off,
    );
    expect(off.stderr).toContain("No model was used (disabled)");
    const dropped = sink();
    await runPreReviewWith(
      client({ markdown: "m", synthesis: { attempted: true, used: false, reason: "timeout" } }),
      { url: "u", json: false, synthesize: true },
      dropped,
    );
    expect(dropped.stderr).toContain("was not used (timeout)");
  });

  test("--json prints the raw reply", async () => {
    const s = sink();
    const reply = { markdown: "m", synthesis: null, brief: { kind: "pr_prereview" } };
    expect(await runPreReviewWith(client(reply), { url: "u", json: true, synthesize: false }, s)).toBe(0);
    expect(JSON.parse(s.stdout)).toEqual(reply);
  });

  test("control and invisible characters are stripped from what is printed", async () => {
    const s = sink();
    await runPreReviewWith(
      client({ markdown: `a\u001b[31mred\u202eb\nline2`, synthesis: null }),
      { url: "u", json: false, synthesize: false },
      s,
    );
    expect(s.stdout).toBe("a [31mred b\nline2\n");
  });

  test("a gateway error is printed and exits 1", async () => {
    const s = sink();
    const code = await runPreReviewWith(
      client(new Error("ERR_PREREVIEW_UNRESOLVED: not indexed\u001b")),
      { url: "u", json: false, synthesize: false },
      s,
    );
    expect(code).toBe(1);
    expect(s.stderr).toBe("ERR_PREREVIEW_UNRESOLVED: not indexed\n");
  });
});
