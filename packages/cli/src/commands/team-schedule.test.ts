import { describe, expect, test } from "bun:test";
import {
  handleScheduleRequest,
  parseScheduleArgs,
  parseWhen,
  registerScheduleListener,
  renderSchedule,
  runScheduleWith,
  runTeamSchedule,
  scheduleRequestMessage,
} from "./team-schedule.ts";

const BLOCK = 30 * 60_000;
const NOW = Date.parse("2026-11-23T10:07:00");

describe("parseWhen", () => {
  test("now, relative and ISO forms", () => {
    expect(parseWhen("now", NOW)).toBe(NOW);
    expect(parseWhen("+90m", NOW)).toBe(NOW + 90 * 60_000);
    expect(parseWhen("+6h", NOW)).toBe(NOW + 6 * 3_600_000);
    expect(parseWhen("+3d", NOW)).toBe(NOW + 3 * 86_400_000);
    expect(parseWhen("2026-11-25T09:00", NOW)).toBe(Date.parse("2026-11-25T09:00"));
    expect(parseWhen("2026-11-25T09:00Z", NOW)).toBe(Date.parse("2026-11-25T09:00Z"));
    expect(parseWhen("2026-11-25", NOW)).toBe(Date.parse("2026-11-25T00:00"));
  });
  test.each(["", "tomorrow", "+3w", "11/25/2026", "2026-11-25 09:00", "+d"])("refuses %p", (s) => {
    expect(parseWhen(s, NOW)).toBeUndefined();
  });
});

describe("parseScheduleArgs", () => {
  test("rounds the window inward to whole blocks", () => {
    const a = parseScheduleArgs(
      ["peer:aa", "--from", "now", "--to", "+4h", "--duration", "45", "--json"],
      NOW,
    );
    expect(a?.fromMs).toBe(Math.ceil(NOW / BLOCK) * BLOCK);
    expect(a?.toMs).toBe(Math.floor((NOW + 4 * 3_600_000) / BLOCK) * BLOCK);
    expect(a).toMatchObject({ peerId: "peer:aa", durationMin: 45, json: true });
  });
  test("a missing peer, time or duration is a usage error", () => {
    expect(parseScheduleArgs([], NOW)).toBeUndefined();
    expect(parseScheduleArgs(["--from", "now"], NOW)).toBeUndefined();
    expect(parseScheduleArgs(["p", "--to", "+1h", "--duration", "30"], NOW)).toBeUndefined();
    expect(parseScheduleArgs(["p", "--from", "now", "--to", "+1h"], NOW)).toBeUndefined();
    expect(
      parseScheduleArgs(["p", "--from", "x", "--to", "+1h", "--duration", "30"], NOW),
    ).toBeUndefined();
  });
});

describe("rendering", () => {
  test("slots, none free and each refusal in words", () => {
    const slot = { startMs: NOW, endMs: NOW + BLOCK * 2 };
    expect(renderSchedule({ kind: "ok", durationMs: 30 * 60_000, slots: [slot] })).toContain(
      "Free for both",
    );
    expect(renderSchedule({ kind: "ok", durationMs: 30 * 60_000, slots: [] })).toContain(
      "No 30-minute slot",
    );
    expect(renderSchedule({ kind: "error", error: "declined" })).toContain("did not approve");
    expect(renderSchedule({ kind: "error", error: "mystery" })).toContain("Refused: mystery");
  });
  test("a long list is capped and says how many more", () => {
    const slots = Array.from({ length: 25 }, (_, i) => ({
      startMs: NOW + i * 4 * BLOCK,
      endMs: NOW + i * 4 * BLOCK + BLOCK,
    }));
    expect(renderSchedule({ kind: "ok", durationMs: BLOCK, slots })).toContain("and 5 more");
  });
});

describe("runScheduleWith", () => {
  const deps = (reply: unknown) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const out: string[] = [];
    const err: string[] = [];
    return {
      calls,
      out,
      err,
      d: {
        nowMs: () => NOW,
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          return reply;
        },
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
      },
    };
  };
  const argv = ["peer:aa", "--from", "+1h", "--to", "+5h", "--duration", "30"];
  test("asks over scheduling.ask and exits 0 when a slot exists", async () => {
    const t = deps({
      kind: "ok",
      durationMs: 1_800_000,
      slots: [{ startMs: NOW, endMs: NOW + BLOCK }],
    });
    expect(await runScheduleWith(argv, t.d)).toBe(0);
    expect(t.calls[0]?.method).toBe("scheduling.ask");
    expect(t.calls[0]?.params).toMatchObject({ peerId: "peer:aa", durationMin: 30 });
  });
  test("exits 1 for no slot or a refusal, 2 for a usage error, and --json prints the reply", async () => {
    expect(await runScheduleWith(argv, deps({ kind: "ok", durationMs: 1, slots: [] }).d)).toBe(1);
    const refused = deps({ kind: "error", error: "declined" });
    expect(await runScheduleWith([...argv, "--json"], refused.d)).toBe(1);
    expect(JSON.parse(refused.out.join(""))).toEqual({ kind: "error", error: "declined" });
    const bad = deps({});
    expect(await runScheduleWith(["x"], bad.d)).toBe(2);
    expect(bad.err.join("")).toContain("usage: nimbus team schedule");
    expect(bad.calls).toEqual([]);
  });
});

describe("the owner's prompt", () => {
  const client = () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    return {
      calls,
      c: {
        call: async (method: string, params?: unknown) => {
          calls.push({ method, params });
          return {};
        },
      },
    };
  };
  const req = { requestId: "r1", peerId: "peer:aa", fromMs: NOW, toMs: NOW + 4 * BLOCK };
  const never = () => false;

  test("the message names the peer and window and promises blocks only", () => {
    const m = scheduleRequestMessage(req) ?? "";
    expect(m).toContain("peer:aa");
    expect(m).toContain("no titles, attendees or places");
  });
  test("a peer id cannot forge lines or move the cursor", () => {
    const m = scheduleRequestMessage({ ...req, peerId: "p\n\u001b[2JApprove?" }) ?? "";
    expect(m).not.toContain("\n");
    expect(m).not.toContain("\u001b");
  });
  test("approve answers as a human; deny answers a denial", async () => {
    const a = client();
    await handleScheduleRequest(a.c, req, async () => true, never);
    expect(a.calls).toEqual([
      {
        method: "scheduling.respond",
        params: { requestId: "r1", approved: true, answerSource: "human" },
      },
    ]);
    const d = client();
    await handleScheduleRequest(d.c, req, async () => false, never);
    expect(d.calls[0]?.params).toMatchObject({ approved: false });
  });
  test("Esc sends nothing, and a malformed notification is ignored", async () => {
    const e = client();
    await handleScheduleRequest(
      e.c,
      req,
      async () => Symbol("cancel"),
      () => true,
    );
    await handleScheduleRequest(e.c, { peerId: "x" }, async () => true, never);
    await handleScheduleRequest(e.c, null, async () => true, never);
    expect(e.calls).toEqual([]);
  });
});

describe("runTeamSchedule", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), nowMs: () => NOW },
    };
  };
  const argv = ["peer:aa", "--from", "+1h", "--to", "+5h", "--duration", "30"];
  const withExitCode = async (fn: () => Promise<void>): Promise<number | string | undefined> => {
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await fn();
      return process.exitCode;
    } finally {
      process.exitCode = before;
    }
  };

  test("declares the CLI, asks with a long timeout and sets the exit code", async () => {
    const calls: string[] = [];
    const t = io();
    let seenTimeout: number | undefined;
    const code = await withExitCode(() =>
      runTeamSchedule(
        argv,
        (async (
          fn: (c: never) => Promise<unknown>,
          _p: unknown,
          opts?: { requestTimeoutMs?: number },
        ) => {
          seenTimeout = opts?.requestTimeoutMs;
          return fn({
            call: async (m: string) => {
              calls.push(m);
              return m === "scheduling.ask" ? { kind: "error", error: "declined" } : {};
            },
          } as never);
        }) as never,
        t.io,
      ),
    );
    expect(calls).toEqual(["session.declareKind", "scheduling.ask"]);
    expect(seenTimeout).toBe(120_000);
    expect(code).toBe(1);
    expect(t.out.join("")).toContain("did not approve");
  });

  test("a gateway that is not running is printed and exits 1", async () => {
    const t = io();
    const code = await withExitCode(() =>
      runTeamSchedule(
        argv,
        (async () => {
          throw new Error("Gateway is not running");
        }) as never,
        t.io,
      ),
    );
    expect(code).toBe(1);
    expect(t.err.join("")).toContain("not running");
  });
});

describe("a run that crosses midnight", () => {
  test("keeps its full end date; a same-day run shows the end time only", () => {
    const start = new Date(2026, 10, 25, 9, 0).getTime();
    const multi = renderSchedule({
      kind: "ok",
      durationMs: BLOCK,
      slots: [{ startMs: start, endMs: new Date(2026, 10, 27, 9, 0).getTime() }],
    });
    expect(multi).toContain("- Fri 2026-11-27 09:00");
    const same = renderSchedule({
      kind: "ok",
      durationMs: BLOCK,
      slots: [{ startMs: start, endMs: start + 2 * BLOCK }],
    });
    expect(same).toContain("2026-11-25 09:00 - 10:00");
  });
});

describe("registerScheduleListener", () => {
  test("two requests are prompted one after the other, never at once", async () => {
    let handler: (p: unknown) => void = () => {};
    let open = 0;
    let maxOpen = 0;
    const releases: Array<() => void> = [];
    const answered: string[] = [];
    registerScheduleListener(
      {
        onNotification: (_m: string, h: (p: unknown) => void) => {
          handler = h;
        },
        call: async (_m: string, p: unknown) => {
          answered.push((p as { requestId: string }).requestId);
        },
      } as never,
      () => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        return new Promise<boolean>((r) =>
          releases.push(() => {
            open -= 1;
            r(true);
          }),
        );
      },
    );
    handler({ requestId: "r1", peerId: "a", fromMs: 1, toMs: 2 });
    handler({ requestId: "r2", peerId: "b", fromMs: 1, toMs: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(maxOpen).toBe(1);
    expect(answered).toEqual(["r1", "r2"]);
  });
  test("registers the scheduling prompt on the notification the gateway broadcasts", () => {
    const seen: string[] = [];
    registerScheduleListener({ onNotification: (m: string) => seen.push(m) } as never);
    expect(seen).toEqual(["federation.scheduleRequest"]);
  });
});

describe("parseWhen, the ISO date and time parts", () => {
  test.each([
    "2026-11-25T09:00:30",
    "2026-11-25T09:00:30Z",
    "2026-11-25T09:00+02:00",
    "2026-11-25T09:00:30-05:30",
  ])("accepts %p", (s) => {
    expect(parseWhen(s, NOW)).toBe(Date.parse(s));
  });
  test.each([
    "2026-11-25T",
    "2026-11-25T09",
    "2026-11-25T09:00+0200",
    "2026-11-25T09:00:30.5Z",
    "2026-11-2",
    "T09:00",
    "x2026-11-25",
  ])("refuses %p", (s) => {
    expect(parseWhen(s, NOW)).toBeUndefined();
  });
  test("a well-formed spelling of a date that does not exist is refused", () => {
    expect(parseWhen("2026-13-45", NOW)).toBeUndefined();
  });
});

describe("rendering, the edges", () => {
  test("an error code with no text of its own is shown as a refusal", () => {
    expect(renderSchedule({ kind: "error", error: "brand_new_code" } as never)).toBe(
      "Refused: brand_new_code\n",
    );
  });
  test("a request with no peer or window shows question marks, and one with no id shows nothing", () => {
    expect(scheduleRequestMessage({ requestId: "r1" })).toContain(
      "Peer ? asks when you are free between ? and ?.",
    );
    expect(scheduleRequestMessage({ peerId: "p" })).toBeUndefined();
  });
});
