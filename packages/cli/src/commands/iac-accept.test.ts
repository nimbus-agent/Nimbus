// OR-S4-ACCEPT-DRIFT: `nimbus iac accept-drift --workdir <dir>`: the parse, the terminal rule, the outcome
// wording and the exit codes. The gateway side is `iac-drift/accept-drift.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  ACCEPT_TTY_REFUSAL,
  type AcceptOutcome,
  formatAccept,
  parseAcceptArgs,
  runAcceptWith,
  runIacCmd,
} from "./iac.ts";

const TTY = { stdin: true, stdout: true };
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
};
function client(outcome: AcceptOutcome | Error) {
  const calls: Array<[string, unknown]> = [];
  const c = {
    call: async <T>(m: string, p?: unknown): Promise<T> => {
      calls.push([m, p]);
      if (m === "iac.acceptDrift") {
        if (outcome instanceof Error) throw outcome;
        return { outcome } as T;
      }
      return {} as T;
    },
  };
  return { c, calls };
}

describe("parseAcceptArgs", () => {
  test("needs one --workdir and nothing a person's approval could be bypassed with", () => {
    expect(parseAcceptArgs(["accept-drift", "--workdir", "/w"])).toEqual({
      workdir: "/w",
      json: false,
    });
    expect(parseAcceptArgs(["accept-drift", "--json", "--workdir", "/w"])?.json).toBe(true);
    for (const bad of [
      ["accept-drift"],
      ["accept-drift", "--workdir"],
      ["accept-drift", "--workdir", ""],
      ["accept-drift", "--workdir", "--json"],
      ["accept-drift", "--workdir", "/a", "--workdir", "/b"],
      ["accept-drift", "--workdir", "/w", "--yes"],
      ["accept-drift", "--workdir", "/w", "-y"],
      ["accept-drift", "--workdir", "/w", "--script-consent-source=ci"],
      ["accept-drift", "/w"],
      ["drift", "--workdir", "/w"],
    ]) {
      expect(parseAcceptArgs(bad), bad.join(" ")).toBeUndefined();
    }
  });
});

describe("runAcceptWith", () => {
  const a = { workdir: "/srv/infra", json: false };

  test("without a terminal it refuses with exit 2 and sends nothing", async () => {
    const h = client({ status: "accepted" });
    const k = sink();
    for (const tty of [
      { stdin: false, stdout: true },
      { stdin: true, stdout: false },
    ]) {
      expect(await runAcceptWith(h.c, a, k.s, tty)).toBe(2);
    }
    expect(h.calls).toEqual([]);
    expect(k.err.join("")).toContain(ACCEPT_TTY_REFUSAL);
  });

  test("declares the cli kind, then asks the gateway; accepted is exit 0", async () => {
    const h = client({ status: "accepted" });
    const k = sink();
    expect(await runAcceptWith(h.c, a, k.s, TTY)).toBe(0);
    expect(h.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["iac.acceptDrift", { workdir: "/srv/infra" }],
    ]);
    expect(k.out.join("")).toContain("no infrastructure was changed");
  });

  test("a decline is exit 1, a refusal for a non-person is exit 2, a failure is exit 1", async () => {
    const k = sink();
    expect(
      await runAcceptWith(
        client({ status: "declined", reason: "denied", nonHuman: false }).c,
        a,
        k.s,
        TTY,
      ),
    ).toBe(1);
    expect(
      await runAcceptWith(
        client({ status: "declined", reason: "denied", nonHuman: true }).c,
        a,
        k.s,
        TTY,
      ),
    ).toBe(2);
    expect(
      await runAcceptWith(
        client({
          status: "failed",
          reason: "accept-drift: the run did not complete",
          nonHuman: false,
        }).c,
        a,
        k.s,
        TTY,
      ),
    ).toBe(1);
    expect(k.out.join("")).toContain("only a person at this terminal");
  });

  test("an RPC error is printed stripped of control characters, exit 1", async () => {
    const k = sink();
    const code = await runAcceptWith(client(new Error("bad\u001b[31m thing")).c, a, k.s, TTY);
    expect(code).toBe(1);
    expect(k.err.join("")).not.toContain("\u001b");
  });

  test("--json prints the outcome", async () => {
    const k = sink();
    await runAcceptWith(client({ status: "accepted" }).c, { ...a, json: true }, k.s, TTY);
    expect(JSON.parse(k.out.join(""))).toEqual({ outcome: { status: "accepted" } });
  });
});

describe("formatAccept", () => {
  test("a reason and a path never carry control characters", () => {
    const s = formatAccept("/w\u001b[2J", {
      status: "declined",
      reason: "no\u0007pe",
      nonHuman: false,
    });
    expect(/\p{Cc}/u.test(s.replace("\n", ""))).toBe(false);
  });
});

describe("runIacCmd accept-drift", () => {
  test("is routed with the human consent mode and the long budget; a usage error never reaches the gateway", async () => {
    const seen: Array<[boolean, boolean | undefined]> = [];
    const k = sink();
    await runIacCmd(
      ["accept-drift", "--workdir", "/w"],
      async (fn, long, human) => {
        seen.push([long, human]);
        return fn(client({ status: "accepted" }).c);
      },
      k.s,
      TTY,
    );
    expect(seen).toEqual([[true, true]]);
    let reached = false;
    const err = await runIacCmd(
      ["accept-drift", "--workdir", "/w", "--yes"],
      async () => {
        reached = true;
        return 0;
      },
      sink().s,
      TTY,
    ).catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(2);
    expect(reached).toBe(false);
  });

  test("a non-zero outcome exits non-zero", async () => {
    const err = await runIacCmd(
      ["accept-drift", "--workdir", "/w"],
      async (fn) => fn(client({ status: "failed", reason: "x", nonHuman: false }).c),
      sink().s,
      TTY,
    ).catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(1);
  });
});
