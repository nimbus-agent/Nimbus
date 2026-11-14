import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { IPCClient } from "../ipc-client/index.ts";

const mod = await import("./prove-by-proposer.ts");
const { formatProposerProof, parseProveByProposerArgs, runProveByProposer } = mod;
const { runProve } = await import("./prove.ts");

const out = captureOutput();
afterAll(() => {
  out.restore();
});

const ESC = String.fromCodePoint(0x1b);
const NOW = 1_800_000_000_000;

function group(over: Record<string, unknown> = {}) {
  return {
    label: "claude-desktop",
    labelSource: "declared",
    proposed: 5,
    refusedAtSubmit: 1,
    approved: 3,
    declined: 1,
    executed: 3,
    failed: 0,
    expired: 0,
    waiting: 0,
    dispatches: 3,
    connections: 1,
    ...over,
  };
}

function proof(over: Record<string, unknown> = {}, completeness: Record<string, unknown> = {}) {
  return {
    labelsVerified: false as const,
    sinceMs: null,
    untilMs: null,
    groups: [group()],
    scanCut: false,
    completeness: {
      status: "ok" as "ok" | "indeterminate",
      causes: [] as string[],
      mismatches: [] as { code: string; captureId: string }[],
      checkedCaptures: 4,
      unreadableRows: 0,
      notChecked: { preVersionCaptures: 0, prunedGateRows: 0 },
      ...completeness,
    },
    ...over,
  };
}

const wired = (call: unknown): void => {
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call, connect: () => {}, disconnect: () => {} },
  });
};

describe("parseProveByProposerArgs", () => {
  it("reads --since as a window relative to now, --proposer and --json", () => {
    const a = parseProveByProposerArgs(
      ["--by-proposer", "--since", "7d", "--proposer", "my agent", "--json"],
      NOW,
    );
    expect(a).toEqual({ sinceMs: NOW - 7 * 86_400_000, proposer: "my agent", json: true });
  });

  it("accepts the bare form", () => {
    expect(parseProveByProposerArgs(["--by-proposer"], NOW)).toEqual({
      sinceMs: undefined,
      proposer: undefined,
      json: false,
    });
  });

  it("refuses a positional argument (it runs no query)", () => {
    expect(() => parseProveByProposerArgs(["--by-proposer", "what did it do"], NOW)).toThrow(
      "no positional argument",
    );
  });

  it.each(["--receipt", "--sign"])(
    "refuses %s (a signature would read as proof of who acted)",
    (f) => {
      expect(() => parseProveByProposerArgs(["--by-proposer", f], NOW)).toThrow("cannot be signed");
    },
  );

  it("refuses an unknown option, a missing value and a bad duration", () => {
    expect(() => parseProveByProposerArgs(["--by-proposer", "--bogus"], NOW)).toThrow(
      "Unknown option",
    );
    expect(() => parseProveByProposerArgs(["--by-proposer", "--since"], NOW)).toThrow(
      "needs a value",
    );
    expect(() => parseProveByProposerArgs(["--by-proposer", "--proposer", "--json"], NOW)).toThrow(
      "needs a value",
    );
    expect(() => parseProveByProposerArgs(["--by-proposer", "--since", "soon"], NOW)).toThrow(
      "Invalid --since",
    );
  });

  it("refuses an empty --proposer", () => {
    expect(() => parseProveByProposerArgs(["--by-proposer", "--proposer", ""], NOW)).toThrow(
      "non-empty",
    );
  });
});

describe("formatProposerProof", () => {
  it("states that labels are unverified and prints each in quotes after UNVERIFIED", () => {
    const text = formatProposerProof(proof() as never);
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("the client's own claim");
    expect(text).toContain('UNVERIFIED label "claude-desktop" (declared)');
    expect(text).toContain(
      "proposed 5, refused at submit 1, approved 3, declined 1, executed 3, failed 0, expired 0, waiting 0",
    );
    expect(text).toContain("dispatches in the egress ledger: 3; connections: 1");
    expect(text).toContain("Both ledgers agree for the 4 proposal(s) checked.");
    expect(text).toContain("You can conclude");
    expect(text).toContain("You cannot conclude which program sent them");
    expect(text).toContain("Not checked: 0 proposal(s)");
  });

  it("prints a null label as (no label) and a window start", () => {
    const text = formatProposerProof(
      proof({ groups: [group({ label: null })], sinceMs: Date.UTC(2026, 10, 1) }) as never,
    );
    expect(text).toContain("UNVERIFIED label (no label)");
    expect(text).toContain("since 2026-11-01 00:00:00 UTC");
  });

  it("keeps a hostile label on one line and strips raw control characters", () => {
    const hostile = `evil\\nline2 ${ESC}[31mred${ESC}[0m\r\nnext`;
    const text = formatProposerProof(proof({ groups: [group({ label: hostile })] }) as never);
    const labelLines = text.split("\n").filter((l) => l.startsWith("UNVERIFIED label"));
    expect(labelLines).toHaveLength(1);
    expect(text).not.toContain(ESC);
    expect(labelLines[0]).toContain('"evil\\nline2 [31mred[0mnext"');
  });

  it("says there are no proposals for an empty window", () => {
    expect(formatProposerProof(proof({ groups: [] }) as never)).toContain(
      "No outside-agent proposals were recorded",
    );
  });

  it.each([
    ["mismatch", "disagree about at least one proposal"],
    ["unreadable_row", "2 audit row(s) of this kind could not be read"],
    ["scan_cut", "row cap"],
    ["audit_chain_broken", "audit log's hash chain does not verify"],
    ["egress_chain_broken", "egress ledger's hash chain does not verify"],
    ["coverage_none", "No boot marker covers this window"],
  ])("an indeterminate proof for cause %s has its own sentence", (cause, sentence) => {
    const text = formatProposerProof(
      proof({}, { status: "indeterminate", causes: [cause], unreadableRows: 2 }) as never,
    );
    expect(text).toContain("INDETERMINATE");
    expect(text).toContain(sentence);
    expect(text).not.toContain("cannot prove zero egress");
    expect(text).not.toContain("Both ledgers agree");
  });

  it("lists mismatches by code and capture id, and names an unknown cause", () => {
    const text = formatProposerProof(
      proof(
        {},
        {
          status: "indeterminate",
          causes: ["mismatch", "something_new"],
          mismatches: [
            { code: "audit_row_without_egress_row", captureId: `cap_${"a".repeat(32)}` },
          ],
        },
      ) as never,
    );
    expect(text).toContain(`audit_row_without_egress_row  cap_${"a".repeat(32)}`);
    expect(text).toContain("Unrecognised reason something_new.");
  });

  it("prints the not-checked counts", () => {
    const text = formatProposerProof(
      proof({}, { notChecked: { preVersionCaptures: 7, prunedGateRows: 9 } }) as never,
    );
    expect(text).toContain(
      "Not checked: 7 proposal(s) accepted before this version recorded the label source; 9 gate row(s) older than the newest egress prune.",
    );
  });
});

describe("runProveByProposer / runProve --by-proposer", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("declares the cli kind first, calls only audit.proveByProposer and exits 0 when ok", async () => {
    const ipc = createMockIpcClient([{}, proof()]);
    await runProveByProposer(ipc.client, { sinceMs: 5, proposer: "x", json: false });
    expect(ipc.calls).toEqual([
      { method: "session.declareKind", params: { kind: "cli" } },
      { method: "audit.proveByProposer", params: { sinceMs: 5, proposer: "x" } },
    ]);
    expect(out.stdout).toContain("UNVERIFIED label");
    expect(process.exitCode).toBe(0);
  });

  it("exits 1 when the proof is indeterminate", async () => {
    const ipc = createMockIpcClient([
      {},
      proof({}, { status: "indeterminate", causes: ["mismatch"] }),
    ]);
    await runProveByProposer(ipc.client, { sinceMs: undefined, proposer: undefined, json: false });
    expect(process.exitCode).toBe(1);
    expect(ipc.calls[1]?.params).toEqual({});
  });

  it("--json prints the reply and still exits 1 when indeterminate", async () => {
    const reply = proof({}, { status: "indeterminate", causes: ["scan_cut"] });
    const ipc = createMockIpcClient([{}, reply]);
    await runProveByProposer(ipc.client, { sinceMs: undefined, proposer: undefined, json: true });
    expect(JSON.parse(out.stdout)).toEqual(reply);
    expect(process.exitCode).toBe(1);
  });

  it("says the gateway is too old on method-not-found, and rethrows any other error", async () => {
    const old = createMockIpcClient([{}, Object.assign(new Error("nf"), { code: -32601 })]);
    await runProveByProposer(old.client, { sinceMs: undefined, proposer: undefined, json: false });
    expect(out.stdout).toContain("too old");
    expect(process.exitCode).toBe(1);

    const bad = createMockIpcClient([{}, new Error("boom")]);
    await expect(
      runProveByProposer(bad.client as IPCClient, {
        sinceMs: undefined,
        proposer: undefined,
        json: false,
      }),
    ).rejects.toThrow("boom");
  });

  it("nimbus prove --by-proposer --since 7d never sends the duration to agent.invoke", async () => {
    const ipc = createMockIpcClient([{}, proof()]);
    wired(ipc.client.call);
    await runProve(["--by-proposer", "--since", "7d"]);
    const methods = ipc.calls.map((c) => c.method);
    expect(methods).toEqual(["session.declareKind", "audit.proveByProposer"]);
    expect(methods).not.toContain("agent.invoke");
    expect(methods).not.toContain("egress.proveWindow");
    const sinceMs = (ipc.calls[1]?.params as { sinceMs: number } | undefined)?.sinceMs ?? 0;
    expect(Math.abs(sinceMs - (Date.now() - 7 * 86_400_000))).toBeLessThan(5_000);
  });

  it("nimbus prove --by-proposer --receipt and a positional argument are usage errors before any call", async () => {
    const ipc = createMockIpcClient([]);
    wired(ipc.client.call);
    await expect(runProve(["--by-proposer", "--receipt"])).rejects.toThrow("cannot be signed");
    await expect(runProve(["--by-proposer", "hello"])).rejects.toThrow("no positional argument");
    expect(ipc.calls).toEqual([]);
  });
});
