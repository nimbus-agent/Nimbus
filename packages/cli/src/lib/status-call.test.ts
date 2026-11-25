import { describe, expect, test } from "bun:test";

import { reportCallFailure, runStatusCall } from "./status-call.ts";

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const upper = (s: string): string => s.toUpperCase();

describe("runStatusCall", () => {
  test("--json prints the reply and exits 0 for an ok status", async () => {
    const s = sink();
    const code = await runStatusCall({
      json: true,
      sink: s.sink,
      clean: upper,
      okStatuses: ["ok", "anomalies"],
      call: async () => ({ status: "anomalies", n: 2 }),
      render: () => 9,
    });
    expect(code).toBe(0);
    expect(s.out).toEqual([`${JSON.stringify({ status: "anomalies", n: 2 })}\n`]);
    expect(s.err).toEqual([]);
  });

  test("--json exits 1 for any other status, and never renders", async () => {
    const s = sink();
    let rendered = false;
    const code = await runStatusCall({
      json: true,
      sink: s.sink,
      clean: upper,
      okStatuses: ["ok"],
      call: async () => ({ status: "no_data" }),
      render: () => {
        rendered = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
  });

  test("without --json the renderer's return value is the exit code", async () => {
    const s = sink();
    const code = await runStatusCall({
      json: false,
      sink: s.sink,
      clean: upper,
      okStatuses: ["ok"],
      call: async () => ({ status: "no_match" }),
      render: (r) => {
        s.sink.out(`rendered ${r.status}`);
        return 3;
      },
    });
    expect(code).toBe(3);
    expect(s.out).toEqual(["rendered no_match"]);
  });

  test("a failed call is { error } on stdout under --json", async () => {
    const s = sink();
    const code = await runStatusCall({
      json: true,
      sink: s.sink,
      clean: upper,
      okStatuses: ["ok"],
      call: async () => {
        throw new Error("gateway gone");
      },
      render: () => 0,
    });
    expect(code).toBe(1);
    expect(s.out).toEqual([`${JSON.stringify({ error: "gateway gone" })}\n`]);
    expect(s.err).toEqual([]);
  });

  test("a renderer that throws is reported like a failed call, cleaned on stderr", async () => {
    const s = sink();
    const code = await runStatusCall({
      json: false,
      sink: s.sink,
      clean: upper,
      okStatuses: ["ok"],
      call: async () => ({ status: "ok" }),
      render: () => {
        throw new Error("bad shape");
      },
    });
    expect(code).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err).toEqual(["BAD SHAPE\n"]);
  });
});

describe("reportCallFailure", () => {
  test("a thrown non-Error is stringified", () => {
    const s = sink();
    expect(reportCallFailure("plain text", false, s.sink, upper)).toBe(1);
    expect(s.err).toEqual(["PLAIN TEXT\n"]);
  });

  test("--json keeps the raw message (the JSON encoder escapes it)", () => {
    const s = sink();
    expect(reportCallFailure(new Error("a\u001b[31m"), true, s.sink, upper)).toBe(1);
    expect(s.out).toEqual([`${JSON.stringify({ error: "a\u001b[31m" })}\n`]);
  });
});
