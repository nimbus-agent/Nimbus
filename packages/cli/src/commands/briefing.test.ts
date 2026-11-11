import { describe, expect, spyOn, test } from "bun:test";

import { CliExit } from "../lib/cli-exit.ts";
import { cleanMarkdown, runBriefingCommand, runBriefingWith } from "./briefing.ts";
import {
  type BriefingStatusLike,
  doctorBriefingLines,
  listLine,
  localTime,
  parseBriefingArgs,
  statusLines,
} from "./briefing-format.ts";
import { doctorPrintBriefing } from "./doctor-core.ts";

const T = Date.UTC(2026, 10, 12, 8, 30);

function harness(replies: Record<string, unknown | Error>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  return {
    out,
    err,
    calls,
    ipc: {
      call: async (m: string) => {
        calls.push(m);
        const r = replies[m];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

const RUN = {
  id: "abcdef123456",
  firedAt: T,
  firedBy: "schedule",
  status: "ok",
  headline: "3 meetings",
  markdown: "# Morning briefing\n\x1b[31mred title\x1b[0m\n",
};

function status(over: Partial<BriefingStatusLike> = {}): BriefingStatusLike {
  return {
    enabled: true,
    schedule: "30 8 * * 1-5",
    tz: "UTC",
    sections: ["calendar", "mail"],
    retentionDays: 30,
    nextFireMs: T,
    lastRun: null,
    deadlines: {
      enabled: true,
      leadHours: 24,
      quietHours: 24,
      lastScanMs: T,
      lastCandidateCount: 2,
      lastNoticeCount: 1,
    },
    sources: [
      { section: "calendar", services: [{ id: "apple", connected: true }] },
      { section: "mail", services: [{ id: "gmail", connected: false }] },
    ],
    toastDelivers: true,
    demo: false,
    ...over,
  };
}

describe("parseBriefingArgs", () => {
  test.each([
    [[], { mode: "latest", json: false }],
    [["--json"], { mode: "latest", json: true }],
    [["now"], { mode: "now", json: false }],
    [["list", "--limit", "5"], { mode: "list", json: false, limit: 5 }],
    [["status", "--json"], { mode: "status", json: true }],
  ])("%j", (argv, want) => {
    expect(parseBriefingArgs(argv)).toEqual(want as never);
  });
  test.each([
    [["bogus"]],
    [["now", "list"]],
    [["--limit", "5"]],
    [["list", "--limit", "0"]],
    [["list", "--limit", "101"]],
    [["list", "--limit"]],
    [["list", "--limit", "5", "--limit", "6"]],
  ])("%j is refused", (argv) => {
    expect(parseBriefingArgs(argv)).toBeUndefined();
  });
});

describe("nimbus briefing", () => {
  test("prints the markdown stripped of control characters, with a footer", async () => {
    const h = harness({ "briefing.latest": { run: RUN } });
    const code = await runBriefingWith(h.ipc, { mode: "latest", json: false }, h.sink, "UTC");
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("red title");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("fired 2026-11-12 08:30 - schedule");
    expect(cleanMarkdown("a\r\nb\x07")).toBe("a\nb");
  });

  test("a headline-only run (no markdown) prints the headline", async () => {
    const h = harness({ "briefing.latest": { run: { ...RUN, markdown: null } } });
    await runBriefingWith(h.ipc, { mode: "latest", json: false }, h.sink, "UTC");
    expect(h.out.join("")).toContain("3 meetings");
  });

  test("no briefing yet is a hint and exit 1; --json prints the raw result", async () => {
    const h = harness({ "briefing.latest": { run: null } });
    expect(await runBriefingWith(h.ipc, { mode: "latest", json: false }, h.sink)).toBe(1);
    expect(h.err.join("")).toContain('No briefing yet. Run "nimbus briefing now"');
    const j = harness({ "briefing.latest": { run: null } });
    expect(await runBriefingWith(j.ipc, { mode: "latest", json: true }, j.sink)).toBe(1);
    expect(JSON.parse(j.out.join(""))).toEqual({ run: null });
    const k = harness({ "briefing.latest": { run: RUN } });
    expect(await runBriefingWith(k.ipc, { mode: "latest", json: true }, k.sink)).toBe(0);
  });

  test("now calls runNow and prints the new run; a failed run exits 1; busy prints the message", async () => {
    const h = harness({ "briefing.runNow": { run: RUN } });
    expect(await runBriefingWith(h.ipc, { mode: "now", json: false }, h.sink, "UTC")).toBe(0);
    expect(h.calls).toEqual(["briefing.runNow"]);
    const j = harness({ "briefing.runNow": { run: { ...RUN, status: "failed" } } });
    expect(await runBriefingWith(j.ipc, { mode: "now", json: true }, j.sink)).toBe(1);
    const b = harness({ "briefing.runNow": new Error("ERR_BRIEFING_BUSY: busy\x1b[2J") });
    expect(await runBriefingWith(b.ipc, { mode: "now", json: false }, b.sink)).toBe(1);
    expect(b.err.join("")).toBe("ERR_BRIEFING_BUSY: busy[2J\n");
    const bj = harness({ "briefing.runNow": new Error("x") });
    expect(await runBriefingWith(bj.ipc, { mode: "now", json: true }, bj.sink)).toBe(1);
    expect(JSON.parse(bj.out.join(""))).toEqual({ error: "x" });
    const s = harness({ "briefing.runNow": "plain" as unknown as Error });
    s.ipc.call = async () => {
      throw "str";
    };
    expect(await runBriefingWith(s.ipc, { mode: "now", json: false }, s.sink)).toBe(1);
  });

  test("list prints one line per run and shows a skip's reason; empty list says so", async () => {
    const h = harness({
      "briefing.list": {
        runs: [
          RUN,
          {
            ...RUN,
            id: "zzzzzzzz9",
            status: "skipped",
            headline: "missed while the gateway was not running",
          },
        ],
      },
    });
    await runBriefingWith(h.ipc, { mode: "list", json: false, limit: 5 }, h.sink, "UTC");
    const lines = h.out.join("").trimEnd().split("\n");
    expect(lines[0]).toBe("abcdef12 2026-11-12 08:30 schedule ok 3 meetings");
    expect(lines[1]).toContain("skipped (missed while the gateway was not running)");
    const e = harness({ "briefing.list": { runs: [] } });
    await runBriefingWith(e.ipc, { mode: "list", json: false }, e.sink);
    expect(e.out.join("")).toBe("No briefing runs yet.\n");
    const j = harness({ "briefing.list": { runs: [] } });
    expect(await runBriefingWith(j.ipc, { mode: "list", json: true }, j.sink)).toBe(0);
  });

  test("status prints the blocks; --json prints the raw status", async () => {
    const h = harness({ "briefing.status": status({ lastRun: { ...RUN, errorMsg: null } }) });
    await runBriefingWith(h.ipc, { mode: "status", json: false }, h.sink);
    const t = h.out.join("");
    expect(t).toContain("Briefing: on");
    expect(t).toContain("Next: 2026-11-12 08:30 (UTC)");
    expect(t).toContain("Deadline notices: on (within 24 h, quiet for 24 h)");
    expect(t).toContain("mail: gmail not connected");
    expect(t).toContain("Toast: will show");
    const j = harness({ "briefing.status": status() });
    await runBriefingWith(j.ipc, { mode: "status", json: true }, j.sink);
    expect(JSON.parse(j.out.join("")).enabled).toBe(true);
  });
});

describe("nimbus briefing errors", () => {
  test("a gateway error is printed (control characters stripped) and exits 1; --json prints it as JSON", async () => {
    const h = harness({ "briefing.latest": new Error("gateway \x1b[31mdown\x1b[0m") });
    expect(await runBriefingWith(h.ipc, { mode: "latest", json: false }, h.sink)).toBe(1);
    expect(h.err.join("")).toContain("gateway");
    expect(h.err.join("")).not.toContain("\x1b");
    expect(h.out).toEqual([]);
    const j = harness({ "briefing.status": new Error("nope") });
    expect(await runBriefingWith(j.ipc, { mode: "status", json: true }, j.sink)).toBe(1);
    expect(JSON.parse(j.out.join(""))).toEqual({ error: "nope" });
  });

  test("a non-Error rejection is stringified", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const ipc = {
      call: async (): Promise<unknown> => {
        throw "plain string";
      },
    };
    const sink = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    expect(await runBriefingWith(ipc, { mode: "list", json: false }, sink)).toBe(1);
    expect(err.join("")).toBe("plain string\n");
  });

  test("runBriefingCommand: bad arguments print the usage and exit 1 without touching the gateway", async () => {
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runBriefingCommand(["no-such-mode"])).rejects.toBeInstanceOf(CliExit);
      expect(String(write.mock.calls[0]?.[0])).toContain("briefing");
    } finally {
      write.mockRestore();
    }
  });
});

describe("format helpers", () => {
  test("statusLines for an off, demo, no-notification install", () => {
    const l = statusLines(
      status({
        enabled: false,
        demo: true,
        nextFireMs: null,
        toastDelivers: false,
        deadlines: {
          enabled: false,
          leadHours: 24,
          quietHours: 24,
          lastScanMs: null,
          lastCandidateCount: null,
          lastNoticeCount: null,
        },
      }),
    ).join("\n");
    expect(l).toContain("Briefing: off (demo)");
    expect(l).toContain("Next: none");
    expect(l).toContain("Last run: none");
    expect(l).toContain("Deadline notices: off");
    expect(l).toContain("will not show");
    const d = statusLines(
      status({
        deadlines: {
          enabled: true,
          leadHours: 1,
          quietHours: 1,
          lastScanMs: null,
          lastCandidateCount: null,
          lastNoticeCount: null,
        },
      }),
    ).join("\n");
    expect(d).toContain("Last deadline scan: none yet");
  });

  test("localTime and listLine default to the machine zone", () => {
    expect(localTime(T, "UTC")).toBe("2026-11-12 08:30");
    expect(typeof localTime(T)).toBe("string");
    expect(listLine(RUN)).toContain("abcdef12");
  });
});

describe("doctor", () => {
  test("silent when both are off", () => {
    expect(
      doctorBriefingLines(
        status({
          enabled: false,
          deadlines: {
            enabled: false,
            leadHours: 24,
            quietHours: 24,
            lastScanMs: null,
            lastCandidateCount: null,
            lastNoticeCount: null,
          },
        }),
      ),
    ).toEqual({ lines: [], exit: 0 });
  });

  test("warns about unconnected sections and a failed scheduled run; ok otherwise", () => {
    const w = doctorBriefingLines(
      status({ lastRun: { ...RUN, status: "failed", errorMsg: "TypeError: x\x1b" } }),
      "UTC",
    );
    expect(w.exit).toBe(1);
    expect(w.lines[0]).toBe(
      "[warn] Morning briefing: enabled but no source is connected for: mail",
    );
    expect(w.lines[1]).toBe(
      "[warn] Morning briefing: the last scheduled briefing failed (TypeError: x)",
    );
    const noMsg = doctorBriefingLines(status({ lastRun: { ...RUN, status: "failed" } }));
    expect(noMsg.lines.join("")).toContain("no error recorded");
    const ok = doctorBriefingLines(
      status({ sources: [{ section: "calendar", services: [{ id: "apple", connected: true }] }] }),
      "UTC",
    );
    expect(ok).toEqual({ lines: ["[ok] Morning briefing: next 2026-11-12 08:30"], exit: 0 });
    const info = doctorBriefingLines(
      status({ sources: [], toastDelivers: false, enabled: false, nextFireMs: null }),
    );
    expect(info.lines[0]).toContain("[info] Morning briefing: notifications will not show");
    const dl = doctorBriefingLines(status({ sources: [], enabled: false, nextFireMs: null }));
    expect(dl.lines).toEqual(["[ok] Morning briefing: deadline notices only"]);
  });

  test("doctorPrintBriefing: older gateway silent; other failure is a warn; status is printed", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await doctorPrintBriefing({ call: async () => Promise.reject({ code: -32601 }) } as never),
      ).toBe(0);
      expect(log).not.toHaveBeenCalled();
      expect(
        await doctorPrintBriefing({ call: async () => Promise.reject(new Error("down")) } as never),
      ).toBe(1);
      expect(await doctorPrintBriefing({ call: async () => Promise.reject("str") } as never)).toBe(
        1,
      );
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "[warn] Morning briefing: status check failed (down)",
      );
      log.mockClear();
      expect(await doctorPrintBriefing({ call: async () => status() } as never)).toBe(1);
      expect(String(log.mock.calls[0]?.[0])).toContain("[warn]");
    } finally {
      log.mockRestore();
    }
  });
});
