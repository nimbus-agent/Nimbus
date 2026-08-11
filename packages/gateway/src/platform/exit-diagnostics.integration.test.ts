import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The unit tests drive a fake `process`. These drive the REAL one, in a real subprocess, because
 * the property that matters is not "the handler was registered" but "the record is on disk after
 * the process is gone" — which only a real exit can demonstrate.
 */

const MODULE_URL = pathToFileURL(join(import.meta.dir, "exit-diagnostics.ts")).href;

type Run = { code: number; records: Array<Record<string, unknown>>; stderr: string };

async function runFixture(body: string, env: Record<string, string> = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-lifecycle-e2e-"));
  const logPath = join(dir, "gateway-daily.log");
  const script = join(dir, "fixture.ts");
  writeFileSync(
    script,
    `import { armGatewayLifecycleDiagnostics } from ${JSON.stringify(MODULE_URL)};\n${body}\n`,
    "utf8",
  );
  try {
    const proc = Bun.spawn(["bun", "run", script], {
      env: { ...process.env, NIMBUS_GATEWAY_LOG_PATH: logPath, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    let raw = "";
    try {
      raw = readFileSync(logPath, "utf8");
    } catch {
      raw = "";
    }
    const records = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, records, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gateway lifecycle diagnostics against the real process", () => {
  test("an event-loop drain — the silent exit-0 mode — is recorded on disk", async () => {
    // This is the shape of the reported failure: no error, no signal, no shutdown path. Before
    // this module it produced a log that simply stopped mid-line.
    const run = await runFixture(`
      armGatewayLifecycleDiagnostics("test-version", () => [], () => ({}));
      setTimeout(() => {}, 10);
    `);
    expect(run.code).toBe(0);
    const events = run.records.map((r) => r["event"]);
    expect(events).toContain("boot");
    expect(events).toContain("before_exit");
    expect(events).toContain("process_exit");
    const exit = run.records.find((r) => r["event"] === "process_exit");
    expect(exit?.["code"]).toBe(0);
    expect(exit?.["drained"]).toBe(true);
  }, 30_000);

  test("an explicit process.exit is recorded and is NOT mislabelled as a drain", async () => {
    const run = await runFixture(`
      armGatewayLifecycleDiagnostics("test-version", () => [], () => ({}));
      process.exit(7);
    `);
    expect(run.code).toBe(7);
    const exit = run.records.find((r) => r["event"] === "process_exit");
    expect(exit?.["code"]).toBe(7);
    expect(exit?.["drained"]).toBe(false);
  }, 30_000);

  test("an uncaught exception lands in the log with its stack, and still exits 1", async () => {
    const run = await runFixture(`
      armGatewayLifecycleDiagnostics("test-version", () => [], () => ({}));
      setTimeout(() => { throw new Error("BOOM-e2e"); }, 5);
      setInterval(() => {}, 60000);
    `);
    expect(run.code).toBe(1);
    const rec = run.records.find((r) => r["event"] === "uncaught_exception");
    expect(rec?.["level"]).toBe(60);
    expect(String(rec?.["stack"])).toContain("BOOM-e2e");
  }, 30_000);

  test("an unhandled rejection lands in the log, and still exits 1", async () => {
    const run = await runFixture(`
      armGatewayLifecycleDiagnostics("test-version", () => [], () => ({}));
      setTimeout(() => { void Promise.reject(new Error("REJECT-e2e")); }, 5);
      setInterval(() => {}, 60000);
    `);
    expect(run.code).toBe(1);
    const rec = run.records.find((r) => r["event"] === "unhandled_rejection");
    expect(rec?.["level"]).toBe(60);
    expect(String(rec?.["reason"])).toContain("REJECT-e2e");
  }, 30_000);

  test("the heartbeat does not by itself keep an otherwise-idle process alive", async () => {
    // A ref'd heartbeat would hang here forever instead of draining.
    const run = await runFixture(
      `
      armGatewayLifecycleDiagnostics("test-version", () => [], () => ({}));
      setTimeout(() => {}, 10);
    `,
      { NIMBUS_HEARTBEAT_MS: "50" },
    );
    expect(run.code).toBe(0);
    expect(run.records.some((r) => r["event"] === "before_exit")).toBe(true);
  }, 30_000);

  test("a heartbeat is written while the process is alive, carrying rss", async () => {
    const run = await runFixture(
      `
      armGatewayLifecycleDiagnostics("test-version", () => [], () => ({}));
      setTimeout(() => {}, 350);
    `,
      { NIMBUS_HEARTBEAT_MS: "60" },
    );
    const hb = run.records.filter((r) => r["event"] === "heartbeat");
    expect(hb.length).toBeGreaterThanOrEqual(1);
    expect(typeof hb[0]?.["rssMb"]).toBe("number");
  }, 30_000);
});
