import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./audit.ts");
const { formatAuditDoorListing, parseAuditDoorArgs, runAudit, runAuditByDoor, runAuditList } = mod;

const out = captureOutput();
afterAll(() => {
  out.restore();
});

const ESC = String.fromCodePoint(0x1b);
const NOW = 1_800_000_000_000;
const CAP = `cap_${"b".repeat(32)}`;

const wired = (call: unknown): void => {
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call, connect: () => {}, disconnect: () => {} },
  });
};

function listing(rows: unknown[], scanCut = false) {
  return { labelsVerified: false as const, rows, scanCut };
}

describe("parseAuditDoorArgs", () => {
  it("reads the door, window, limit and json", () => {
    expect(
      parseAuditDoorArgs(["--door", "model", "--since", "24h", "--limit", "20", "--json"], NOW),
    ).toEqual({
      door: "model",
      proposer: undefined,
      sinceMs: NOW - 86_400_000,
      limit: 20,
      json: true,
    });
  });

  it.each(["agent", "model", "workflow", "other"])("accepts the %s door", (d) => {
    expect(parseAuditDoorArgs(["--door", d], NOW).door).toBe(d as never);
  });

  it("--proposer implies the agent door", () => {
    const a = parseAuditDoorArgs(["--proposer", "claude-desktop"], NOW);
    expect(a.door).toBe("agent");
    expect(a.proposer).toBe("claude-desktop");
    expect(parseAuditDoorArgs(["--door", "agent", "--proposer", "x"], NOW).door).toBe("agent");
  });

  it("--proposer with another door is a usage error", () => {
    expect(() => parseAuditDoorArgs(["--door", "model", "--proposer", "x"], NOW)).toThrow(
      "agent door only",
    );
    expect(() => parseAuditDoorArgs(["--door", "other", "--proposer", "x"], NOW)).toThrow(
      "agent door only",
    );
  });

  it("refuses a missing door, an unknown door, a bad limit and stray arguments", () => {
    expect(() => parseAuditDoorArgs(["--json"], NOW)).toThrow("--door is required");
    expect(() => parseAuditDoorArgs(["--door", "owner"], NOW)).toThrow("Unknown door");
    expect(() => parseAuditDoorArgs(["--door", "agent", "--limit", "0"], NOW)).toThrow("--limit");
    expect(() => parseAuditDoorArgs(["--door", "agent", "--limit", "1001"], NOW)).toThrow(
      "--limit",
    );
    expect(() => parseAuditDoorArgs(["--door", "agent", "--limit", "x"], NOW)).toThrow("--limit");
    expect(() => parseAuditDoorArgs(["--door", "agent", "stray"], NOW)).toThrow("positional");
    expect(() => parseAuditDoorArgs(["--door", "agent", "--bogus"], NOW)).toThrow("Unknown option");
    expect(() => parseAuditDoorArgs(["--door"], NOW)).toThrow("needs a value");
    expect(() => parseAuditDoorArgs(["--proposer", ""], NOW)).toThrow("non-empty");
  });
});

describe("parseAuditDoorArgs - repeated flags and the = form", () => {
  it("a repeated option is a usage error, never last-one-wins", () => {
    for (const args of [
      ["--door", "agent", "--door", "model"],
      ["--proposer", "a", "--proposer", "b"],
      ["--door", "agent", "--since", "7d", "--since", "1d"],
      ["--door", "agent", "--limit", "5", "--limit", "6"],
      ["--proposer", "a", "--proposer=b"],
    ]) {
      expect(() => parseAuditDoorArgs(args, NOW)).toThrow("more than once");
    }
  });

  it("--proposer=<label> selects a label that starts with --", () => {
    const a = parseAuditDoorArgs(["--proposer=--nightly"], NOW);
    expect(a.proposer).toBe("--nightly");
    expect(a.door).toBe("agent");
    expect(parseAuditDoorArgs(["--door", "agent", "--proposer=a=b"], NOW).proposer).toBe("a=b");
  });

  it("the space-separated form still refuses a label that looks like a flag", () => {
    expect(() => parseAuditDoorArgs(["--proposer", "--nightly"], NOW)).toThrow("needs a value");
  });

  it("--proposer= with nothing after it is a usage error", () => {
    expect(() => parseAuditDoorArgs(["--proposer="], NOW)).toThrow("non-empty");
  });

  it("runAudit routes --proposer=<label> to the door view with the label", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    wired((method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(listing([]));
    });
    await runAudit(["--proposer=--nightly"]);
    expect(calls.find((c) => c.method === "audit.listByDoor")?.params).toMatchObject({
      door: "agent",
      proposer: "--nightly",
    });
  });
});

describe("formatAuditDoorListing", () => {
  const base = {
    door: "agent" as const,
    proposer: undefined,
    sinceMs: undefined,
    limit: undefined,
    json: false,
  };

  it("prints timestamp, action, status, capture id, the UNVERIFIED label and the reason", () => {
    const text = formatAuditDoorListing(
      base,
      listing([
        {
          id: 9,
          timestamp: Date.UTC(2026, 10, 14, 8, 30, 0),
          actionType: "slack.message.post",
          hitlStatus: "rejected",
          door: "agent",
          subStep: false,
          captureId: CAP,
          label: "claude-desktop",
          labelSource: "declared",
          reason: "user-cancelled",
        },
        {
          id: 8,
          timestamp: Date.UTC(2026, 10, 14, 8, 29, 0),
          actionType: "jira.issue.before.read",
          hitlStatus: "not_required",
          door: "agent",
          subStep: true,
          captureId: CAP,
        },
      ]) as never,
    );
    expect(text).toContain("Audit rows through the agent door, newest first.");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain(
      `2026-11-14 08:30:00  ${"slack.message.post".padEnd(28)} ${"rejected".padEnd(17)} ${CAP} UNVERIFIED label "claude-desktop"  reason: user-cancelled`,
    );
    expect(text).toContain("(sub-step of the proposal)");
  });

  it("shows a null label, a row from before AD4, and strips control characters", () => {
    const text = formatAuditDoorListing(
      base,
      listing([
        {
          id: 1,
          timestamp: NOW,
          actionType: "a",
          hitlStatus: "approved",
          door: "agent",
          subStep: false,
          captureId: CAP,
          label: null,
        },
        {
          id: 2,
          timestamp: NOW,
          actionType: "a",
          hitlStatus: "approved",
          door: "agent",
          subStep: false,
          captureId: CAP,
        },
        {
          id: 3,
          timestamp: NOW,
          actionType: "a",
          hitlStatus: "approved",
          door: "agent",
          subStep: false,
          captureId: CAP,
          label: `x${ESC}[31my`,
          reason: `r${ESC}z`,
        },
      ]) as never,
    );
    expect(text).toContain("UNVERIFIED label (no label)");
    expect(text).toContain("UNVERIFIED label not recorded (older row)");
    expect(text).not.toContain(ESC);
    expect(text).toContain('"x[31my"');
  });

  it("prints no label cell for other doors, and says what `other` is", () => {
    const text = formatAuditDoorListing(
      { ...base, door: "other" },
      listing([
        {
          id: 1,
          timestamp: NOW,
          actionType: "file.delete",
          hitlStatus: "approved",
          door: "other",
          subStep: false,
        },
      ]) as never,
    );
    expect(text).toContain("not claimed to be the owner's");
    expect(text).not.toContain("UNVERIFIED label");
    expect(text).toContain("file.delete");
  });

  it("says when the scan was cut and when there are no rows", () => {
    expect(
      formatAuditDoorListing({ ...base, door: "model" }, listing([], true) as never),
    ).toContain("The scan was cut at its row cap");
    expect(formatAuditDoorListing({ ...base, door: "workflow" }, listing([]) as never)).toContain(
      "No rows came through the workflow door",
    );
  });

  it("with --proposer and no rows, says no row in the window has that label (not that the door was empty)", () => {
    const text = formatAuditDoorListing(
      { ...base, door: "agent", proposer: "ghost" },
      listing([]) as never,
    );
    expect(text).toContain('No row through the agent door in this window has the label "ghost"');
    expect(text).not.toContain("No rows came through");
  });
});

describe("runAuditByDoor / runAudit --door", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("declares the cli kind first and calls audit.listByDoor with the params", async () => {
    const ipc = createMockIpcClient([{}, listing([])]);
    await runAuditByDoor(ipc.client, {
      door: "agent",
      proposer: "x",
      sinceMs: 5,
      limit: 7,
      json: false,
    });
    expect(ipc.calls).toEqual([
      { method: "session.declareKind", params: { kind: "cli" } },
      {
        method: "audit.listByDoor",
        params: { door: "agent", proposer: "x", sinceMs: 5, limit: 7 },
      },
    ]);
  });

  it("--json prints the reply", async () => {
    const reply = listing([
      {
        id: 1,
        timestamp: 1,
        actionType: "a",
        hitlStatus: "approved",
        door: "model",
        subStep: false,
      },
    ]);
    const ipc = createMockIpcClient([{}, reply]);
    await runAuditByDoor(ipc.client, {
      door: "model",
      proposer: undefined,
      sinceMs: undefined,
      limit: undefined,
      json: true,
    });
    expect(JSON.parse(out.stdout)).toEqual(reply);
  });

  it("an older gateway gets a plain line and exit 1; another error is rethrown", async () => {
    const old = createMockIpcClient([{}, Object.assign(new Error("nf"), { code: -32601 })]);
    await runAuditByDoor(old.client, {
      door: "agent",
      proposer: undefined,
      sinceMs: undefined,
      limit: undefined,
      json: false,
    });
    expect(out.stdout).toContain("too old");
    expect(process.exitCode).toBe(1);
    const bad = createMockIpcClient([{}, new Error("boom")]);
    await expect(
      runAuditByDoor(bad.client, {
        door: "agent",
        proposer: undefined,
        sinceMs: undefined,
        limit: undefined,
        json: false,
      }),
    ).rejects.toThrow("boom");
  });

  it("nimbus audit --proposer X routes to the door view (implies agent), not audit.list", async () => {
    const ipc = createMockIpcClient([{}, listing([])]);
    wired(ipc.client.call);
    await runAudit(["--proposer", "X"]);
    expect(ipc.calls.map((c) => c.method)).toEqual(["session.declareKind", "audit.listByDoor"]);
    expect(ipc.calls[1]?.params).toEqual({ door: "agent", proposer: "X" });
  });

  it("nimbus audit --door model with --proposer is a usage error before any call", async () => {
    const ipc = createMockIpcClient([]);
    wired(ipc.client.call);
    await expect(runAudit(["--door", "model", "--proposer", "X"])).rejects.toThrow(
      "agent door only",
    );
    expect(ipc.calls).toEqual([]);
  });
});

describe("the unfiltered nimbus audit output is unchanged", () => {
  beforeEach(() => {
    out.reset();
  });

  it("prints exactly the table it printed before the door view existed", async () => {
    const rows = [
      {
        id: 1,
        actionType: "file.delete",
        hitlStatus: "rejected",
        actionJson: '{"hitlRejectReason":"user-cancelled"}',
        timestamp: 1700000000000,
      },
      {
        id: 2,
        actionType: "email.send",
        hitlStatus: "approved",
        actionJson: "{}",
        timestamp: 1700000060000,
      },
    ];
    const ipc = createMockIpcClient([rows]);
    await runAuditList(ipc.client, 50);
    expect(out.stdout).toBe(
      [
        "Timestamp            Action                 Status            Reason",
        "-".repeat(75),
        "2023-11-14 22:13:20  file.delete            rejected          user-cancelled",
        "2023-11-14 22:14:20  email.send             approved          —",
        "",
      ].join("\n"),
    );
  });

  it("does not leave the plain path for --limit and --json", async () => {
    const ipc = createMockIpcClient([[]]);
    wired(ipc.client.call);
    await runAudit(["--limit", "3", "--json"]);
    expect(ipc.calls).toEqual([{ method: "audit.list", params: { limit: 3 } }]);
  });
});
