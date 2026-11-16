import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./audit.ts");
const { AUDIT_REPLAY_USAGE, formatReplay, parseAuditReplayArgs, runAuditReplay } = mod;

const out = captureOutput();
afterAll(() => out.restore());
afterEach(() => {
  out.reset();
  process.exitCode = 0;
});

const T = Date.UTC(2026, 10, 12, 8, 30);
const ESC = String.fromCodePoint(0x1b);
const RLO = String.fromCodePoint(0x202e);

const range = (over: Record<string, unknown> = {}) => ({
  anchorId: 4,
  toId: 9,
  rowsRead: 2,
  ok: true,
  verifiedRows: 5,
  firstBreak: null,
  reason: null,
  ...over,
});

function replay(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    record: {
      id: "inc_0123456789abcdef",
      triggerItemId: "pagerduty:PD1",
      service: "payments",
      currentVersion: 2,
      versions: [
        {
          version: 1,
          assembledAtMs: T,
          recordSha256: "a".repeat(64),
          changedKeys: ["binding", "trigger"],
        },
        { version: 2, assembledAtMs: T + 60_000, recordSha256: "b".repeat(64), changedKeys: [] },
      ],
    },
    actions: [
      {
        auditId: 7,
        timestamp: T + 120_000,
        actionType: "slack.message.post",
        hitlStatus: "approved",
        answerSource: "human",
        confirm: "matched",
        linkVersion: 2,
        unknownVersion: false,
        rowTruncated: false,
        egress: {
          id: 8,
          resultStatus: "authorized",
          paired: "paired",
          summaryMismatch: false,
          statusDiffers: false,
        },
        prompt: {
          text: `Action requires approval\nType: x${ESC}[31m ${RLO}evil`,
          cut: true,
          sha256: "c".repeat(64),
        },
        subSteps: [
          {
            auditId: 6,
            timestamp: T + 120_000,
            actionType: "slack.before.read",
            hitlStatus: "not_required",
            answerSource: null,
            confirm: null,
            linkVersion: 2,
            unknownVersion: false,
            rowTruncated: false,
            egress: null,
          },
        ],
      },
    ],
    proposals: { note: "No proposals are recorded before IC5." },
    verification: { audit: range(), egress: range({ anchorId: 0 }) },
    notes: ["note one"],
    ...over,
  };
}

describe("parseAuditReplayArgs", () => {
  it("takes one id and an optional --json", () => {
    expect(parseAuditReplayArgs(["inc_x"])).toEqual({ id: "inc_x", json: false });
    expect(parseAuditReplayArgs(["--json", "inc_x"])).toEqual({ id: "inc_x", json: true });
  });
  it("refuses a missing id, two ids, a repeated or unknown flag", () => {
    for (const bad of [[], ["a", "b"], ["a", "--json", "--json"], ["a", "--bogus"], ["--json"]]) {
      expect(() => parseAuditReplayArgs(bad), bad.join(" ")).toThrow(AUDIT_REPLAY_USAGE);
    }
  });
});

describe("formatReplay", () => {
  it("prints versions, the action with its sub-step, the escaped prompt, the proposals note and both ranges", () => {
    const text = formatReplay(replay() as never);
    expect(text).toContain(
      "Replay of incident record inc_0123456789abcdef (trigger pagerduty:PD1, service payments)",
    );
    expect(text).toContain(
      "v1  2026-11-12 08:30:00 UTC  sha256 aaaaaaaaaaaa  changed: binding, trigger",
    );
    expect(text).toContain("v2  2026-11-12 08:31:00 UTC  sha256 bbbbbbbbbbbb  changed: nothing");
    expect(text).toContain(
      "#7 2026-11-12 08:32:00 UTC slack.message.post  approved  answered by human  typed confirmation: matched  record version 2",
    );
    expect(text).toContain("egress #8 authorized");
    expect(text).toContain("sub-step #6");
    expect(text).toContain("no egress row paired");
    expect(text).toContain("prompt shown (cut), sha256 cccccccccccc:");
    expect(text).toContain("No proposals are recorded before IC5.");
    expect(text).toContain("audit chain: ok over rows after #4 up to #9 (2 read, 5 verified)");
    expect(text).toContain("egress chain: ok over rows after #0 up to #9");
    expect(text).toContain("Note: note one");
  });

  it("escapes the prompt: no raw newline, escape or bidi character reaches the terminal", () => {
    const text = formatReplay(replay() as never);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(RLO);
    expect(text.split("\n").filter((l) => l.includes("Action requires approval"))).toHaveLength(1);
    expect(text).toContain(String.raw`Action requires approval\nType: x\u001b[31m evil`);
  });

  it("a broken chain, an unread range, a pairing flag and an unknown version are all stated", () => {
    const text = formatReplay(
      replay({
        ok: false,
        verification: {
          audit: range({ ok: false, firstBreak: 6, reason: "row_hash mismatch at id 6" }),
          egress: null,
        },
        actions: [
          {
            ...(replay().actions[0] as object),
            unknownVersion: true,
            rowTruncated: true,
            egress: {
              id: 8,
              resultStatus: "blocked",
              paired: "ambiguous",
              summaryMismatch: true,
              statusDiffers: true,
            },
            prompt: null,
            subSteps: [],
          },
        ],
      }) as never,
    );
    expect(text).toContain("audit chain: BROKEN at #6 over rows after #4 up to #9");
    expect(text).toContain("egress chain: not verified (no rows read)");
    expect(text).toContain("record version 2 (not stored)");
    expect(text).toContain("(row cut by the audit cap)");
    expect(text).toContain(
      "pairing ambiguous; summary head does not name this record (summary_mismatch); status differs from the verdict",
    );
  });

  it("no linked action says so", () => {
    expect(formatReplay(replay({ actions: [] }) as never)).toContain("No linked actions.");
  });
});

describe("runAuditReplay", () => {
  const client = (
    reply: unknown,
  ): { call: (m: string, p?: unknown) => Promise<unknown>; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      call: async (m, p) => {
        calls.push([m, JSON.stringify(p)]);
        if (m === "session.declareKind") return {};
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
  };

  it("declares cli first, asks for the record and prints the replay; exit 0 on an intact chain", async () => {
    const c = client(replay());
    await runAuditReplay(c as never, { id: "inc_x", json: false });
    expect(c.calls.map((x) => x[0])).toEqual(["session.declareKind", "audit.replay"]);
    expect(c.calls[1]?.[1]).toBe('{"id":"inc_x"}');
    expect(out.stdout).toContain("Replay of incident record");
    expect(process.exitCode).toBe(0);
  });

  it("--json asks for the full records and prints the raw reply", async () => {
    const c = client(replay());
    await runAuditReplay(c as never, { id: "inc_x", json: true });
    expect(c.calls[1]?.[1]).toBe('{"id":"inc_x","full":true}');
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true });
  });

  it("exit 1 on a broken chain, with the rest still printed", async () => {
    await runAuditReplay(client(replay({ ok: false })) as never, { id: "inc_x", json: false });
    expect(process.exitCode).toBe(1);
    expect(out.stdout).toContain("Nimbus actions for this record");
  });

  it("exit 2 on an unknown id; any other error propagates", async () => {
    await runAuditReplay(
      client(new Error("ERR_INCIDENT_NOT_FOUND: no incident record has that id")) as never,
      {
        id: "x",
        json: false,
      },
    );
    expect(process.exitCode).toBe(2);
    expect(out.stderr).toContain("ERR_INCIDENT_NOT_FOUND");
    await expect(
      runAuditReplay(client(new Error("socket closed")) as never, { id: "x", json: false }),
    ).rejects.toThrow("socket closed");
  });
});
