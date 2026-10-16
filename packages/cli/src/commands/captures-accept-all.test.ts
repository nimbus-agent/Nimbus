import { describe, expect, test } from "bun:test";

import {
  ACCEPT_ALL_MAX,
  type Ask,
  type CapturesArgs,
  parseCapturesArgs,
  runCapturesWith,
} from "./captures.ts";

const TTY = { stdin: true, stdout: true };

type Row = { id: string; kind: string; title: string; createdAt: number; state?: string };

function summary(r: Row): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state ?? "proposed",
    title: r.title,
    clientLabel: "claude-code",
    createdAt: r.createdAt,
    decidedAt: null,
    expiresAt: null,
  };
}

/** A gateway double: `captures.list` filters by kind; `captures.accept` follows `acceptImpl`. */
function gateway(rows: Row[], acceptImpl: (id: string) => unknown = () => undefined) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    client: {
      call: async <T>(m: string, p?: unknown): Promise<T> => {
        calls.push([m, p]);
        const params = (p ?? {}) as Record<string, unknown>;
        if (m === "captures.list") {
          const got = rows
            .filter((r) => r.kind === params["kind"])
            .sort((x, y) =>
              params["order"] === "asc" ? x.createdAt - y.createdAt : y.createdAt - x.createdAt,
            )
            .map(summary);
          return { captures: got.slice(0, Number(params["limit"] ?? 50)) } as T;
        }
        if (m === "captures.accept") {
          const id = String(params["id"]);
          const out = acceptImpl(id);
          return (out ?? { id, state: "accepted", nativeRef: `capture:${id}` }) as T;
        }
        throw new Error(`unexpected ${m}`);
      },
    },
  };
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
}

function answering(answer: string): { ask: Ask; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: (q) => {
      asked.push(q);
      return Promise.resolve(answer);
    },
  };
}

const ALL: CapturesArgs = { verb: "acceptAll", json: false };
const ROWS: Row[] = [
  { id: "cap_t", kind: "term", title: "WAL", createdAt: 30 },
  { id: "cap_d", kind: "decision", title: "Use WAL", createdAt: 10 },
  { id: "cap_l", kind: "link", title: "rel: a → b", createdAt: 20 },
];

function accepts(calls: Array<[string, unknown]>): string[] {
  return calls
    .filter(([m]) => m === "captures.accept")
    .map(([, p]) => String((p as { id: string }).id));
}

describe("parseCapturesArgs — accept --all", () => {
  test.each([
    [["accept", "--all"], { verb: "acceptAll", json: false }],
    [["accept", "--all", "--json"], { verb: "acceptAll", json: true }],
    [["accept", "--all", "--kind", "term"], { verb: "acceptAll", kind: "term", json: false }],
    [["accept", "--all", "--kind", "action"], { verb: "acceptAll", kind: "action", json: false }],
  ])("%j", (argv, want) => {
    expect(parseCapturesArgs(argv)).toEqual(want as never);
  });

  test.each([
    [["accept", "--all", "cap_1"]],
    [["accept", "--all", "--kind"]],
    [["accept", "--all", "--kind", "note"]],
    [["accept", "--all", "--kind", "term", "--kind", "link"]],
    [["accept", "cap_1", "--all"]],
  ])("%j is a usage error", (argv) => {
    expect(parseCapturesArgs(argv)).toBeUndefined();
  });
});

describe("runCapturesWith — accept --all", () => {
  test("lists oldest first, asks once, accepts every native proposal", async () => {
    const g = gateway(ROWS);
    const o = sink();
    const q = answering("y");
    expect(await runCapturesWith(g.client, ALL, o.s, TTY, q.ask)).toBe(0);
    expect(q.asked).toEqual(["Accept these 3 proposal(s)? [y/N] "]);
    expect(accepts(g.calls)).toEqual(["cap_d", "cap_l", "cap_t"]);
    // One list per native kind, never one for actions.
    const listed = g.calls
      .filter(([m]) => m === "captures.list")
      .map(([, p]) => (p as { kind: string }).kind);
    expect(listed).toEqual(["decision", "term", "link"]);
    const text = o.out.join("");
    expect(text.indexOf("cap_d")).toBeLessThan(text.indexOf("cap_l"));
    expect(text).toContain("Accepted 3 of 3.");
  });

  test("anything but y/yes accepts nothing and exits 1", async () => {
    for (const answer of ["", "n", "no", "maybe"]) {
      const g = gateway(ROWS);
      const o = sink();
      expect(await runCapturesWith(g.client, ALL, o.s, TTY, answering(answer).ask)).toBe(1);
      expect(accepts(g.calls)).toEqual([]);
      expect(o.err.join("")).toContain("Accepted nothing.");
    }
    const g = gateway(ROWS);
    expect(await runCapturesWith(g.client, ALL, sink().s, TTY, answering("YES").ask)).toBe(0);
  });

  test("without a TTY it refuses before any gateway call", async () => {
    for (const tty of [
      { stdin: false, stdout: true },
      { stdin: true, stdout: false },
    ]) {
      const g = gateway(ROWS);
      const o = sink();
      const q = answering("y");
      expect(await runCapturesWith(g.client, ALL, o.s, tty, q.ask)).toBe(1);
      expect(g.calls).toEqual([]);
      expect(q.asked).toEqual([]);
      expect(o.err.join("")).toContain("requires an interactive terminal");
    }
  });

  test("the defaults fail closed: no TTY facts and no way to ask accept nothing", async () => {
    const g = gateway(ROWS);
    expect(await runCapturesWith(g.client, ALL, sink().s)).toBe(1);
    expect(g.calls).toEqual([]);
    const h = gateway(ROWS);
    expect(await runCapturesWith(h.client, ALL, sink().s, TTY)).toBe(1);
    expect(accepts(h.calls)).toEqual([]);
  });

  test("--kind action is refused before any gateway call", async () => {
    const g = gateway(ROWS);
    const o = sink();
    const a: CapturesArgs = { verb: "acceptAll", kind: "action", json: false };
    expect(await runCapturesWith(g.client, a, o.s, TTY, answering("y").ask)).toBe(1);
    expect(g.calls).toEqual([]);
    expect(o.err.join("")).toContain("never accepted in a batch");
  });

  test("an action row the gateway returns anyway never reaches captures.accept", async () => {
    const g = gateway([]);
    const inner = g.client.call;
    g.client.call = async <T>(m: string, p?: unknown): Promise<T> => {
      if (m === "captures.list") {
        return {
          captures: [
            summary({ id: "cap_a", kind: "action", title: "slack: hi", createdAt: 1 }),
            summary({
              id: "cap_x",
              kind: "decision",
              title: "done",
              createdAt: 2,
              state: "accepted",
            }),
          ],
        } as T;
      }
      return inner<T>(m, p);
    };
    const o = sink();
    expect(await runCapturesWith(g.client, ALL, o.s, TTY, answering("y").ask)).toBe(0);
    expect(accepts(g.calls)).toEqual([]);
    expect(o.out.join("")).toContain("No proposed decisions, terms or links to accept.");
  });

  test("--kind narrows to one list call", async () => {
    const g = gateway(ROWS);
    const a: CapturesArgs = { verb: "acceptAll", kind: "term", json: false };
    expect(await runCapturesWith(g.client, a, sink().s, TTY, answering("y").ask)).toBe(0);
    expect(g.calls.filter(([m]) => m === "captures.list")).toHaveLength(1);
    expect(accepts(g.calls)).toEqual(["cap_t"]);
  });

  test("one refusal does not stop the run; the exit is 1", async () => {
    const g = gateway(ROWS, (id) => {
      if (id === "cap_l") throw new Error("ERR_CAPTURE_LINK_UNRESOLVED: endpoint gone");
      return undefined;
    });
    const o = sink();
    expect(await runCapturesWith(g.client, ALL, o.s, TTY, answering("y").ask)).toBe(1);
    expect(accepts(g.calls)).toEqual(["cap_d", "cap_l", "cap_t"]);
    const text = o.out.join("");
    expect(text).toContain("[refused] cap_l: ERR_CAPTURE_LINK_UNRESOLVED");
    expect(text).toContain("accepted cap_t");
    expect(text).toContain("Accepted 2 of 3.");
  });

  test("a malformed accept result counts as a refusal, not a success", async () => {
    const g = gateway(ROWS.slice(0, 1), () => ({ state: "accepted" }));
    const o = sink();
    expect(await runCapturesWith(g.client, ALL, o.s, TTY, answering("y").ask)).toBe(1);
    expect(o.out.join("")).toContain("Accepted 0 of 1.");
  });

  test("an empty queue says so, asks nothing and exits 0", async () => {
    const g = gateway([]);
    const o = sink();
    const q = answering("y");
    expect(await runCapturesWith(g.client, ALL, o.s, TTY, q.ask)).toBe(0);
    expect(q.asked).toEqual([]);
    expect(o.out.join("")).toBe("No proposed decisions, terms or links to accept.\n");
  });

  test("more than one run's worth: takes the oldest ACCEPT_ALL_MAX and says more wait", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ACCEPT_ALL_MAX + 5; i++) {
      rows.push({
        id: `cap_${String(i).padStart(3, "0")}`,
        kind: i % 2 ? "term" : "decision",
        title: "t",
        createdAt: i,
      });
    }
    const g = gateway(rows);
    const o = sink();
    const q = answering("y");
    expect(await runCapturesWith(g.client, ALL, o.s, TTY, q.ask)).toBe(0);
    expect(q.asked).toEqual([`Accept these ${String(ACCEPT_ALL_MAX)} proposal(s)? [y/N] `]);
    const ids = accepts(g.calls);
    expect(ids).toHaveLength(ACCEPT_ALL_MAX);
    expect(ids[0]).toBe("cap_000");
    expect(o.out.join("")).toContain("More proposals are waiting than one run accepts (200)");
  });

  test("more than ACCEPT_ALL_MAX of ONE kind: the gateway is asked oldest first, so the oldest go", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < ACCEPT_ALL_MAX + 5; i++) {
      rows.push({
        id: `cap_${String(i).padStart(3, "0")}`,
        kind: "term",
        title: "t",
        createdAt: i,
      });
    }
    const g = gateway(rows);
    const a: CapturesArgs = { verb: "acceptAll", kind: "term", json: false };
    expect(await runCapturesWith(g.client, a, sink().s, TTY, answering("y").ask)).toBe(0);
    expect(g.calls[0]).toEqual([
      "captures.list",
      { state: "proposed", kind: "term", order: "asc", limit: ACCEPT_ALL_MAX },
    ]);
    const ids = accepts(g.calls);
    expect(ids[0]).toBe("cap_000");
    expect(ids.at(-1)).toBe(`cap_${String(ACCEPT_ALL_MAX - 1).padStart(3, "0")}`);
  });

  test("agent text is control-stripped in the listing", async () => {
    const g = gateway([{ id: "cap_d", kind: "decision", title: "a\u001b[31mred", createdAt: 1 }]);
    const o = sink();
    await runCapturesWith(g.client, ALL, o.s, TTY, answering("n").ask);
    expect(o.out.join("")).not.toContain("\u001b");
  });

  test("--json: stdout is one JSON result; listing goes to stderr", async () => {
    const g = gateway(ROWS, (id) => {
      if (id === "cap_t") throw new Error("ERR_CAPTURE_SUPERSEDED");
      return undefined;
    });
    const o = sink();
    const a: CapturesArgs = { verb: "acceptAll", json: true };
    expect(await runCapturesWith(g.client, a, o.s, TTY, answering("y").ask)).toBe(1);
    expect(JSON.parse(o.out.join(""))).toEqual({
      accepted: 2,
      total: 3,
      more: false,
      results: [
        { id: "cap_d", state: "accepted", nativeRef: "capture:cap_d" },
        { id: "cap_l", state: "accepted", nativeRef: "capture:cap_l" },
        { id: "cap_t", error: "ERR_CAPTURE_SUPERSEDED" },
      ],
    });
    expect(o.err.join("")).toContain("oldest first");
  });
});
