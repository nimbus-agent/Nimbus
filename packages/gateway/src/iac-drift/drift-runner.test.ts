import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerraformDriftOutcome } from "../engine/executor.ts";
import {
  createIacDriftRunner,
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

  test("running() is true while a check is in flight and false after a failure", async () => {
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
    await expect(p).rejects.toThrow("x");
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
    expect(isNewDrift(f("clean", 0), f("drift", 1))).toBe(true);
    expect(isNewDrift(f("drift", 1), f("drift", 1))).toBe(false);
    expect(isNewDrift(f("drift", 1), f("drift", 2))).toBe(true);
  });
});
