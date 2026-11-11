import { describe, expect, test } from "bun:test";

import { nextFire } from "./cron.ts";
import {
  refuseModelSteps,
  resolveSaveSchedule,
  SCHEDULE_INVALID,
  SCHEDULE_LOCAL_ONLY,
  SCHEDULE_NEEDS_NO_MODEL,
  ScheduleSaveError,
} from "./workflow-schedule.ts";

const NOW = Date.UTC(2026, 10, 11, 8, 0);
const WRITE_ONLY = JSON.stringify([
  {
    kind: "query",
    label: "q",
    query: { service: "gmail", type: "email", select: "metadata.threadId", limit: 5 },
  },
  {
    kind: "write",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "q", column: "metadata.threadId" } },
  },
]);

const base = {
  schedule: "0 6 * * *",
  scheduleTz: "UTC",
  stepsJson: WRITE_ONLY,
  clientKind: "cli" as const,
  now: NOW,
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ScheduleSaveError);
    return (e as ScheduleSaveError).code;
  }
  throw new Error("expected a refusal");
}

describe("resolveSaveSchedule", () => {
  test("no schedule asked for is null, which clears; a zone alone is refused", () => {
    expect(resolveSaveSchedule({ ...base, schedule: undefined, scheduleTz: undefined })).toBeNull();
    expect(resolveSaveSchedule({ ...base, schedule: null, scheduleTz: null })).toBeNull();
    expect(codeOf(() => resolveSaveSchedule({ ...base, schedule: undefined }))).toBe(
      SCHEDULE_INVALID,
    );
  });

  test("a valid schedule resolves with its first fire in the zone", () => {
    const out = resolveSaveSchedule(base);
    expect(out).toEqual({
      expr: "0 6 * * *",
      tz: "UTC",
      nextAt: nextFire("0 6 * * *", "UTC", NOW) as number,
    });
    expect(resolveSaveSchedule({ ...base, schedule: "  @daily  " })?.expr).toBe("@daily");
  });

  test("the zone defaults to the machine zone, through the seam", () => {
    const out = resolveSaveSchedule({
      ...base,
      scheduleTz: undefined,
      machineTz: () => "Asia/Tokyo",
    });
    expect(out?.tz).toBe("Asia/Tokyo");
    expect(
      codeOf(() =>
        resolveSaveSchedule({ ...base, scheduleTz: undefined, machineTz: () => "Nope/X" }),
      ),
    ).toBe(SCHEDULE_INVALID);
  });

  test("only cli and ui may set one", () => {
    for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      expect(
        codeOf(() => resolveSaveSchedule({ ...base, clientKind: kind })),
        kind,
      ).toBe(SCHEDULE_LOCAL_ONLY);
    }
    expect(resolveSaveSchedule({ ...base, clientKind: "ui" })).not.toBeNull();
  });

  test("a non-string schedule or zone, a blank schedule and a bad zone are refused", () => {
    for (const over of [
      { schedule: 5 },
      { schedule: "  " },
      { scheduleTz: 5 },
      { scheduleTz: "Mars/Olympus" },
      { schedule: "*/1 * * * *" },
      { schedule: "0 0 30 2 *" },
    ]) {
      expect(
        codeOf(() => resolveSaveSchedule({ ...base, ...over })),
        JSON.stringify(over),
      ).toBe(SCHEDULE_INVALID);
    }
  });

  test("a model step refuses the schedule; steps that do not parse refuse it too", () => {
    expect(
      codeOf(() => resolveSaveSchedule({ ...base, stepsJson: JSON.stringify([{ run: "x" }]) })),
    ).toBe(SCHEDULE_NEEDS_NO_MODEL);
    expect(codeOf(() => refuseModelSteps("not json"))).toBe(SCHEDULE_INVALID);
    expect(() => refuseModelSteps(WRITE_ONLY)).not.toThrow();
  });
});
