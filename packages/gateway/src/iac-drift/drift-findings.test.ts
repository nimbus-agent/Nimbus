import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IAC_PREFLIGHT_REFUSALS } from "../connectors/connector-writes/iac-limits.ts";
import { PREPARE_REFUSALS } from "../engine/prepare-step.ts";
import {
  DRIFT_UNREADABLE_REASON,
  type DriftFinding,
  driftDir,
  findingFromOutcome,
  readLatestFindings,
  writeLatestFindings,
} from "./drift-findings.ts";

const plan = (o: { driftCount?: number | null; changeCount?: number; driftLines?: string[] }) => ({
  lines: [],
  text: "",
  bytes: 0,
  sha256: "a".repeat(64),
  ...o,
});

describe("findingFromOutcome", () => {
  test("drift: the count, the planned changes and the renderer's drift lines", () => {
    const f = findingFromOutcome(
      "/w",
      {
        ok: true,
        workingDirectory: "/w",
        plan: plan({ driftCount: 2, changeCount: 3, driftLines: ["Drift: 2", "  [x]"] }),
      },
      5,
      "schedule",
    );
    expect(f).toEqual({
      workdir: "/w",
      checkedAt: 5,
      startedBy: "schedule",
      status: "drift",
      driftCount: 2,
      plannedChanges: 3,
      lines: ["Drift: 2", "  [x]"],
    });
  });

  test("drift with no lines on the plan stores none", () => {
    const f = findingFromOutcome(
      "/w",
      { ok: true, workingDirectory: "/w", plan: plan({ driftCount: 1 }) },
      1,
      "owner_cli",
    );
    expect(f.lines).toEqual([]);
    expect(f.plannedChanges).toBeNull();
  });

  test("clean: zero drift, no lines", () => {
    const f = findingFromOutcome(
      "/w",
      { ok: true, workingDirectory: "/w", plan: plan({ driftCount: 0, changeCount: 0 }) },
      1,
      "owner_cli",
    );
    expect(f.status).toBe("clean");
    expect(f.lines).toEqual([]);
  });

  test("an unreadable drift report (null or absent) is a failed finding with its fixed reason", () => {
    for (const p of [plan({ driftCount: null }), plan({})]) {
      const f = findingFromOutcome(
        "/w",
        { ok: true, workingDirectory: "/w", plan: p },
        1,
        "owner_cli",
      );
      expect(f.status).toBe("failed");
      expect(f.reason).toBe(DRIFT_UNREADABLE_REASON);
    }
  });

  test("a busy workdir is busy; any other refusal is failed with that reason", () => {
    expect(
      findingFromOutcome("/w", { ok: false, reason: IAC_PREFLIGHT_REFUSALS.busy }, 1, "schedule")
        .status,
    ).toBe("busy");
    const f = findingFromOutcome(
      "/w",
      { ok: false, reason: PREPARE_REFUSALS.failed },
      1,
      "schedule",
    );
    expect(f).toMatchObject({
      status: "failed",
      reason: PREPARE_REFUSALS.failed,
      driftCount: null,
    });
  });
});

describe("the latest-findings file (no migration)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const finding = (workdir: string, status: DriftFinding["status"] = "clean"): DriftFinding => ({
    workdir,
    checkedAt: 1,
    startedBy: "owner_cli",
    status,
    driftCount: status === "clean" ? 0 : null,
    plannedChanges: null,
    lines: [],
    ...(status === "failed" ? { reason: "x" } : {}),
  });

  test("a missing file reads as no findings", () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-drift-"));
    expect(readLatestFindings(dir)).toEqual([]);
  });

  test("writes merge per workdir, sorted, and round-trip", () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-drift-"));
    writeLatestFindings(dir, [finding("/b"), finding("/a", "failed")]);
    writeLatestFindings(dir, [finding("/b", "busy")]);
    const got = readLatestFindings(dir);
    expect(got.map((f) => [f.workdir, f.status])).toEqual([
      ["/a", "failed"],
      ["/b", "busy"],
    ]);
    if (process.platform !== "win32") {
      expect(statSync(join(driftDir(dir), "latest.json")).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(join(driftDir(dir), "latest.json"), "utf8"))).toHaveLength(2);
  });

  test("a malformed file, a non-array and malformed entries read as nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-drift-"));
    mkdirSync(driftDir(dir), { recursive: true });
    const path = join(driftDir(dir), "latest.json");
    writeFileSync(path, "{not json");
    expect(readLatestFindings(dir)).toEqual([]);
    writeFileSync(path, JSON.stringify({ a: 1 }));
    expect(readLatestFindings(dir)).toEqual([]);
    const good = finding("/ok");
    const bad: unknown[] = [
      null,
      [],
      { ...good, workdir: "" },
      { ...good, checkedAt: "x" },
      { ...good, startedBy: "peer" },
      { ...good, status: "great" },
      { ...good, driftCount: -1 },
      { ...good, plannedChanges: 1.5 },
      { ...good, lines: [1] },
      { ...good, lines: "x" },
      { ...good, reason: 5 },
    ];
    writeFileSync(path, JSON.stringify([good, ...bad]));
    expect(readLatestFindings(dir)).toEqual([good]);
  });
});
