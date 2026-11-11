import { describe, expect, test } from "bun:test";

import {
  formatScheduleTable,
  parseScheduleArgs,
  runScheduleCmd,
  runScheduleWith,
  SCHEDULE_USAGE,
  type ScheduleEntry,
} from "./schedule.ts";

const ENTRY: ScheduleEntry = {
  name: "weekly-mail-clean",
  schedule: "0 6 * * *",
  timezone: "UTC",
  nextFireAt: Date.UTC(2026, 10, 12, 6, 0),
  lastFireAt: Date.UTC(2026, 10, 11, 6, 0),
  lastRunStatus: "done",
  blockedRunId: null,
  blockedStepLabel: null,
};

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
}

describe("parseScheduleArgs", () => {
  test("list is the default verb; --json is a flag; anything else is refused", () => {
    expect(parseScheduleArgs([])).toEqual({ verb: "list", json: false });
    expect(parseScheduleArgs(["list"])).toEqual({ verb: "list", json: false });
    expect(parseScheduleArgs(["list", "--json"])).toEqual({ verb: "list", json: true });
    expect(parseScheduleArgs(["--json"])).toEqual({ verb: "list", json: true });
    expect(parseScheduleArgs(["add"])).toBeUndefined();
    expect(parseScheduleArgs(["list", "extra"])).toBeUndefined();
  });
});

describe("formatScheduleTable", () => {
  test("an empty list says so", () => {
    expect(formatScheduleTable([])).toBe("No scheduled workflows.\n");
  });

  test("shows the expression, zone, next and last fire in that zone, and the last run's status", () => {
    const text = formatScheduleTable([ENTRY]);
    expect(text).toContain("weekly-mail-clean");
    expect(text).toContain("0 6 * * *");
    expect(text).toContain("2026-11-12 06:00");
    expect(text).toContain("2026-11-11 06:00");
    expect(text).toContain("done");
    expect(text).not.toContain("resume");
  });

  test("a blocked workflow prints the exact command that resumes the run", () => {
    const text = formatScheduleTable([
      { ...ENTRY, blockedRunId: "run-123", blockedStepLabel: "archive" },
    ]);
    expect(text).toContain("waiting for approval");
    expect(text).toContain("step archive needs your approval: nimbus workflow resume run-123");
  });

  test("never-run and never-fired workflows read plainly, and terminal controls are stripped", () => {
    const text = formatScheduleTable([
      {
        ...ENTRY,
        name: "evil\u001b[2Jname",
        lastFireAt: null,
        lastRunStatus: null,
        blockedRunId: "r\u0007x",
        blockedStepLabel: null,
      },
    ]);
    expect(text).toContain("never");
    expect(text).toContain("a write step");
    // Only the line breaks the table itself prints are control characters.
    expect(text.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  });

  test("an unknown zone falls back to UTC rather than throwing", () => {
    expect(formatScheduleTable([{ ...ENTRY, timezone: "Not/AZone" }])).toContain(
      "2026-11-12 06:00",
    );
  });
});

describe("runScheduleWith", () => {
  test("prints the table, or JSON, from workflow.scheduleList", async () => {
    const calls: string[] = [];
    const c = {
      call: async <T>(method: string): Promise<T> => {
        calls.push(method);
        return { schedules: [ENTRY] } as T;
      },
    };
    const text = sink();
    expect(await runScheduleWith(c, { verb: "list", json: false }, text.s)).toBe(0);
    expect(text.out.join("")).toContain("weekly-mail-clean");
    const json = sink();
    expect(await runScheduleWith(c, { verb: "list", json: true }, json.s)).toBe(0);
    expect(JSON.parse(json.out.join(""))).toEqual({ schedules: [ENTRY] });
    expect(calls).toEqual(["workflow.scheduleList", "workflow.scheduleList"]);
  });

  test("a gateway error is printed safely and exits 1", async () => {
    const c = {
      call: async <T>(): Promise<T> => {
        throw new Error("boom\u001b[31m");
      },
    };
    const e = sink();
    expect(await runScheduleWith(c, { verb: "list", json: false }, e.s)).toBe(1);
    expect(e.err.join("")).toContain("boom");
    expect(e.err.join("")).not.toContain("\u001b");
  });
});

describe("runScheduleCmd", () => {
  test("a bad verb prints the usage and exits 2 before connecting", async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      written.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(runScheduleCmd(["nope"])).rejects.toMatchObject({ code: 2 });
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toContain(SCHEDULE_USAGE);
  });
});

describe("remaining branches", () => {
  test("a workflow that never ran reads 'no runs'; a non-Error rejection is printed", async () => {
    expect(formatScheduleTable([{ ...ENTRY, lastRunStatus: null }])).toContain("no runs");
    const c = {
      call: async <T>(): Promise<T> => {
        throw "plain string";
      },
    };
    const e = sink();
    expect(await runScheduleWith(c, { verb: "list", json: false }, e.s)).toBe(1);
    expect(e.err.join("")).toContain("plain string");
  });

  test("a blocked run with a known step label names that step", () => {
    expect(
      formatScheduleTable([{ ...ENTRY, blockedRunId: "r1", blockedStepLabel: "archive" }]),
    ).toContain("step archive");
  });
});
