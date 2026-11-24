import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IAC_PREFLIGHT_REFUSALS } from "../connectors/connector-writes/iac-limits.ts";
import type { TerraformDriftOutcome } from "../engine/executor.ts";
import {
  createIacDriftRunner,
  DRIFT_CHECK_ERROR_REASON,
  DRIFT_NOTIFY_TITLE,
  driftNotifyBody,
  IacDriftNotApprovedError,
  isNewDrift,
} from "./drift-runner.ts";

const drift = (n: number): TerraformDriftOutcome => ({
  ok: true,
  workingDirectory: "/w",
  plan: {
    lines: [],
    text: "",
    bytes: 0,
    sha256: "a".repeat(64),
    changeCount: 1,
    driftCount: n,
    driftLines: ["Drift: summary", "  [changed outside Terraform] aws_s3_bucket.secret_name"],
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-drift-runner-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runner(outcomes: Record<string, TerraformDriftOutcome[]>, notifyEnabled = true) {
  const checked: string[] = [];
  const notes: Array<[string, string]> = [];
  const r = createIacDriftRunner({
    makeExecutor: () => ({
      checkTerraformDrift: async (w) => {
        checked.push(w);
        return outcomes[w]?.shift() ?? { ok: false, reason: "none" };
      },
    }),
    approvedWorkdirs: () => ["/a", "/b"],
    dataDir: dir,
    now: () => 1,
    notify: (t, b) => notes.push([t, b]),
    notifyEnabled: () => notifyEnabled,
  });
  return { r, checked, notes };
}

describe("the drift runner", () => {
  test("checks every approved workdir in turn and stores the findings", async () => {
    const h = runner({ "/a": [drift(0)], "/b": [drift(2)] });
    const out = await h.r.check({ startedBy: "owner_cli" });
    expect(h.checked).toEqual(["/a", "/b"]);
    expect(out.map((f) => f.status)).toEqual(["clean", "drift"]);
    expect(h.r.latest().map((f) => f.workdir)).toEqual(["/a", "/b"]);
    expect(h.r.running()).toBe(false);
  });

  test("checks one named workdir; an unapproved one is refused before any check", async () => {
    const h = runner({ "/b": [drift(0)] });
    expect(await h.r.check({ workdir: "/b", startedBy: "owner_cli" })).toHaveLength(1);
    await expect(h.r.check({ workdir: "/etc", startedBy: "owner_cli" })).rejects.toBeInstanceOf(
      IacDriftNotApprovedError,
    );
    expect(h.checked).toEqual(["/b"]);
  });

  test("an owner check never notifies", async () => {
    const h = runner({ "/a": [drift(1)], "/b": [drift(1)] });
    await h.r.check({ startedBy: "owner_cli" });
    expect(h.notes).toEqual([]);
  });

  test("a scheduled check notifies new or changed drift once, with a count and the workdir only", async () => {
    const h = runner({
      "/a": [drift(2), drift(2), drift(3)],
      "/b": [drift(0), drift(0), drift(0)],
    });
    await h.r.check({ startedBy: "schedule" });
    await h.r.check({ startedBy: "schedule" });
    await h.r.check({ startedBy: "schedule" });
    expect(h.notes).toEqual([
      [DRIFT_NOTIFY_TITLE, "2 objects changed outside Terraform in /a"],
      [DRIFT_NOTIFY_TITLE, "3 objects changed outside Terraform in /a"],
    ]);
    for (const [, body] of h.notes) expect(body).not.toContain("secret_name");
  });

  test("a busy or failed check in between does not count as the drift clearing", async () => {
    const busy: TerraformDriftOutcome = { ok: false, reason: IAC_PREFLIGHT_REFUSALS.busy };
    const h = runner({
      "/a": [drift(2), busy, { ok: false, reason: "x" }, drift(2)],
      "/b": [drift(0), drift(0), drift(0), drift(0)],
    });
    for (let i = 0; i < 4; i++) await h.r.check({ startedBy: "schedule" });
    expect(h.notes).toEqual([[DRIFT_NOTIFY_TITLE, "2 objects changed outside Terraform in /a"]]);
    expect(h.r.latest().find((x) => x.workdir === "/a")?.observedDriftCount).toBeUndefined();
  });

  test("the baseline is the finding committed last, not the one read when the check started", async () => {
    let release: () => void = () => {};
    const outcomes: Record<string, TerraformDriftOutcome[]> = { "/b": [drift(2), drift(0)] };
    const notes: string[] = [];
    const r = createIacDriftRunner({
      makeExecutor: () => ({
        checkTerraformDrift: async (w) => {
          if (w === "/a") {
            await new Promise<void>((res) => {
              release = res;
            });
            return drift(0);
          }
          return outcomes[w]?.shift() ?? drift(0);
        },
      }),
      approvedWorkdirs: () => ["/a", "/b"],
      dataDir: dir,
      now: () => 1,
      notify: (_t, b) => notes.push(b),
    });
    await r.check({ workdir: "/b", startedBy: "owner_cli" });
    outcomes["/b"] = [drift(2)];
    const scheduled = r.check({ startedBy: "schedule" });
    await Promise.resolve();
    // While the scheduled check waits on /a, the owner records /b as clean.
    outcomes["/b"] = [drift(0)];
    await r.check({ workdir: "/b", startedBy: "owner_cli" });
    outcomes["/b"] = [drift(2)];
    release();
    await scheduled;
    expect(notes).toEqual(["2 objects changed outside Terraform in /b"]);
  });

  test("one workdir's check that throws is a failed finding; the others are still checked and stored", async () => {
    const r = createIacDriftRunner({
      makeExecutor: () => ({
        checkTerraformDrift: async (w) => {
          if (w === "/a") throw new Error("secret detail");
          return drift(0);
        },
      }),
      approvedWorkdirs: () => ["/a", "/b"],
      dataDir: dir,
      now: () => 1,
    });
    const out = await r.check({ startedBy: "owner_cli" });
    expect(out.map((x) => [x.workdir, x.status, x.reason])).toEqual([
      ["/a", "failed", DRIFT_CHECK_ERROR_REASON],
      ["/b", "clean", undefined],
    ]);
  });

  test("wasRunningAt: a running check from its start, and the last finished one's interval", async () => {
    let t = 10;
    let finish: () => void = () => {};
    const r = createIacDriftRunner({
      makeExecutor: () => ({
        checkTerraformDrift: () =>
          new Promise<TerraformDriftOutcome>((res) => {
            finish = () => res(drift(0));
          }),
      }),
      approvedWorkdirs: () => ["/a"],
      dataDir: dir,
      now: () => t,
    });
    expect(r.wasRunningAt(10)).toBe(false);
    const p = r.check({ startedBy: "owner_cli" });
    await Promise.resolve();
    expect(r.wasRunningAt(9)).toBe(false);
    expect(r.wasRunningAt(11)).toBe(true);
    t = 20;
    finish();
    await p;
    expect(r.wasRunningAt(15)).toBe(true);
    expect(r.wasRunningAt(21)).toBe(false);
    expect(r.wasRunningAt(5)).toBe(false);
  });

  test("notify off: a scheduled check notifies nothing", async () => {
    const h = runner({ "/a": [drift(2)], "/b": [drift(0)] }, false);
    await h.r.check({ startedBy: "schedule" });
    expect(h.notes).toEqual([]);
  });

  test("with no notifier a scheduled check still stores its findings", async () => {
    const r = createIacDriftRunner({
      makeExecutor: () => ({ checkTerraformDrift: async () => drift(2) }),
      approvedWorkdirs: () => ["/a"],
      dataDir: dir,
      now: () => 1,
    });
    await r.check({ startedBy: "schedule" });
    expect(r.latest().map((f) => f.status)).toEqual(["drift"]);
  });

  test("running() is true while a check is in flight and false after one that threw", async () => {
    let fail: () => void = () => {};
    const r = createIacDriftRunner({
      makeExecutor: () => ({
        checkTerraformDrift: () =>
          new Promise<TerraformDriftOutcome>((_res, rej) => {
            fail = () => rej(new Error("x"));
          }),
      }),
      approvedWorkdirs: () => ["/a"],
      dataDir: dir,
      now: () => 1,
    });
    const p = r.check({ startedBy: "schedule" });
    await Promise.resolve();
    expect(r.running()).toBe(true);
    fail();
    expect((await p)[0]?.status).toBe("failed");
    expect(r.running()).toBe(false);
  });
});

describe("notification helpers", () => {
  const f = (status: "drift" | "clean", n: number | null, workdir = "/a") => ({
    workdir,
    checkedAt: 1,
    startedBy: "schedule" as const,
    status,
    driftCount: n,
    plannedChanges: null,
    lines: [],
  });

  test("the body strips control and format characters from the workdir", () => {
    expect(driftNotifyBody(f("drift", 4, "/a\u202Eb\nc"))).toBe(
      "4 objects changed outside Terraform in /a?b?c",
    );
  });

  test("isNewDrift: only drift is news, and only when it appears or its count changes", () => {
    expect(isNewDrift(undefined, f("clean", 0))).toBe(false);
    expect(isNewDrift(undefined, f("drift", 1))).toBe(true);
    expect(isNewDrift(0, f("drift", 1))).toBe(true);
    expect(isNewDrift(1, f("drift", 1))).toBe(false);
    expect(isNewDrift(1, f("drift", 2))).toBe(true);
  });
});

describe("the drift runner's accept (OR-S4-ACCEPT-DRIFT)", () => {
  const base = {
    makeExecutor: () => ({
      checkTerraformDrift: async () => ({ ok: false as const, reason: "x" }),
    }),
    approvedWorkdirs: () => ["/a"],
    now: () => 1,
  };

  test("accepts through the accept executor, on the connection named", async () => {
    const made: string[] = [];
    const r = createIacDriftRunner({
      ...base,
      dataDir: dir,
      makeAcceptExecutor: ({ clientId }) => {
        made.push(clientId);
        return { execute: async () => ({ status: "ok" as const, result: {} }) };
      },
    });
    expect(await r.accept({ workdir: "/a", clientId: "c9" })).toEqual({ status: "accepted" });
    expect(made).toEqual(["c9"]);
  });

  test("a gateway with no accept executor refuses, and an unapproved workdir never reaches one", async () => {
    const none = createIacDriftRunner({ ...base, dataDir: dir });
    await expect(none.accept({ workdir: "/a", clientId: "c" })).rejects.toThrow(
      "no accept executor",
    );
    const some = createIacDriftRunner({
      ...base,
      dataDir: dir,
      makeAcceptExecutor: () => {
        throw new Error("must not be built");
      },
    });
    await expect(some.accept({ workdir: "/etc", clientId: "c" })).rejects.toThrow(
      "not an approved",
    );
  });
});
