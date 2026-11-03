import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createNetworkObservationWriter,
  MAX_FILE_BYTES,
  MAX_FILES,
  type NetworkObservationWriterOptions,
  observationTempPath,
  parseObservationLabel,
  writeObservationFileAtomic,
} from "./network-observation-writer.ts";
import {
  SANDBOX_CWD_ENV,
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  SANDBOX_POLICY_ENV,
} from "./sandbox-policy.ts";

type Written = { path: string; body: Record<string, unknown>; bytes: number };

const LABEL = { extensionId: "com.example.weather", version: "1.2.3" };

function harness(over: Partial<NetworkObservationWriterOptions> = {}) {
  let clock = 1_000;
  const files: Written[] = [];
  const writer = createNetworkObservationWriter({
    prefix: "/obs/ext_weather.1000.deadbeef",
    label: LABEL,
    os: "linux",
    networkObserved: true,
    now: () => clock,
    flushMs: 0,
    writeFileAtomic: (path, bytes) => {
      files.push({
        path,
        body: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
        bytes: bytes.length,
      });
    },
    ...over,
  });
  return {
    writer,
    files,
    tick: (ms: number) => {
      clock += ms;
    },
    last: (): Record<string, unknown> => {
      const f = files.at(-1);
      if (f === undefined) throw new Error("no file written");
      return f.body;
    },
  };
}

const entriesOf = (body: Record<string, unknown>) =>
  body["entries"] as { o: string; h: string; p: number; n: number }[];

describe("createNetworkObservationWriter", () => {
  test("coalesces used and refused events by key, with counts", () => {
    const h = harness();
    h.writer.used("api.github.com", 443);
    h.writer.used("api.github.com", 443);
    h.writer.used("api.github.com", 8443);
    h.writer.refused("undeclared.invalid");
    h.writer.refused("undeclared.invalid");
    h.writer.refused("undeclared.invalid");
    h.writer.flush(false);
    expect(entriesOf(h.last())).toEqual([
      { o: "used", h: "api.github.com", p: 443, n: 2 },
      { o: "used", h: "api.github.com", p: 8443, n: 1 },
      { o: "refused", h: "undeclared.invalid", p: 0, n: 3 },
    ]);
    expect(h.last()["dropped"]).toBe(0);
  });

  test("writes the exact body shape, and names the file <prefix>.<seq>.json", () => {
    const h = harness();
    h.tick(500);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    expect(h.files[0]?.path).toBe("/obs/ext_weather.1000.deadbeef.0.json");
    expect(h.last()).toEqual({
      v: 1,
      label: LABEL,
      seq: 0,
      runStart: true,
      os: "linux",
      networkObserved: true,
      fromMs: 1_000,
      toMs: 1_500,
      final: false,
      entries: [{ o: "used", h: "api.github.com", p: 443, n: 1 }],
      dropped: 0,
    });
  });

  test("stores a hostile name sanitised", () => {
    const h = harness();
    h.writer.refused("a\nb\u0000c");
    h.writer.flush(false);
    expect(entriesOf(h.last())).toEqual([{ o: "refused", h: "a?b?c", p: 0, n: 1 }]);
  });

  test("caps a name at 253 characters before keying it", () => {
    const h = harness();
    h.writer.refused(`${"a".repeat(253)}x`);
    h.writer.refused(`${"a".repeat(253)}y`);
    h.writer.flush(false);
    expect(entriesOf(h.last())).toEqual([{ o: "refused", h: "a".repeat(253), p: 0, n: 2 }]);
  });

  test("300 distinct names in one window give 256 entries and dropped 44", () => {
    const h = harness();
    for (let i = 0; i < 300; i += 1) h.writer.refused(`n${String(i)}.example.org`);
    h.writer.flush(false);
    expect(entriesOf(h.last())).toHaveLength(256);
    expect(h.last()["dropped"]).toBe(44);
  });

  test("a flood of refused names never hides a connection that was used", () => {
    const h = harness();
    for (let i = 0; i < 300; i += 1) h.writer.refused(`n${String(i)}.example.org`);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    const entries = entriesOf(h.last());
    expect(entries).toHaveLength(256);
    expect(entries[0]).toEqual({ o: "used", h: "api.github.com", p: 443, n: 1 });
    expect(h.last()["dropped"]).toBe(45);
  });

  test("the body stays within 64 KiB with 256 entries of 253-character names", () => {
    const h = harness();
    for (let i = 0; i < 256; i += 1) {
      h.writer.refused(`${String(i).padStart(3, "0")}${"x".repeat(260)}`);
    }
    h.writer.flush(false);
    const file = h.files[0];
    expect(file?.bytes).toBeLessThanOrEqual(MAX_FILE_BYTES);
    const kept = entriesOf(h.last());
    expect(kept.every((e) => e.h.length === 253)).toBe(true);
    // What did not fit is counted, never lost silently.
    expect(kept.length + (h.last()["dropped"] as number)).toBe(256);
    expect(kept.length).toBeGreaterThan(200);
  });

  test("seq increments, only seq 0 has runStart, and each window starts where the last ended", () => {
    const h = harness();
    h.writer.flush(false);
    h.tick(60_000);
    h.writer.flush(false);
    h.tick(60_000);
    h.writer.flush(false);
    expect(h.files.map((f) => f.body["seq"])).toEqual([0, 1, 2]);
    expect(h.files.map((f) => f.body["runStart"])).toEqual([true, false, false]);
    expect(h.files.map((f) => [f.body["fromMs"], f.body["toMs"]])).toEqual([
      [1_000, 1_000],
      [1_000, 61_000],
      [61_000, 121_000],
    ]);
  });

  test("close writes final true once, and later events write nothing", () => {
    const h = harness();
    h.writer.used("api.github.com", 443);
    h.writer.close();
    h.writer.close();
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    expect(h.files).toHaveLength(1);
    expect(h.last()["final"]).toBe(true);
  });

  test("every file carries the label verbatim", () => {
    const h = harness();
    h.writer.flush(false);
    h.writer.flush(false);
    h.writer.close();
    expect(h.files.map((f) => f.body["label"])).toEqual([LABEL, LABEL, LABEL]);
  });

  test("file 1441 is the stopped marker, and later events write nothing", () => {
    const h = harness();
    for (let i = 0; i < MAX_FILES; i += 1) h.writer.flush(false);
    expect(h.files).toHaveLength(MAX_FILES);
    expect(h.files.some((f) => "stopped" in f.body)).toBe(false);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    expect(h.files).toHaveLength(MAX_FILES + 1);
    expect(h.last()["stopped"]).toBe(true);
    expect(h.last()["seq"]).toBe(MAX_FILES);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    h.writer.close();
    expect(h.files).toHaveLength(MAX_FILES + 1);
  });

  test("a throwing writeFileAtomic never throws out, and its loss is counted in the next file", () => {
    let fail = true;
    const written: Record<string, unknown>[] = [];
    const h = harness({
      writeFileAtomic: (_path, bytes) => {
        if (fail) throw new Error("disk full");
        written.push(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
      },
    });
    h.writer.used("api.github.com", 443);
    h.writer.refused("x.invalid");
    expect(() => h.writer.flush(false)).not.toThrow();
    fail = false;
    expect(() => h.writer.used("api.github.com", 443)).not.toThrow();
    h.writer.flush(false);
    expect(written).toHaveLength(1);
    // The lost first file's two keys are counted, and the run's start is not lost with it.
    expect(written[0]?.["dropped"]).toBe(2);
    expect(written[0]?.["seq"]).toBe(0);
    expect(written[0]?.["runStart"]).toBe(true);
  });

  test("its own timer writes a window every flushMs", async () => {
    const h = harness({ flushMs: 20, now: Date.now });
    await Bun.sleep(120);
    h.writer.close();
    expect(h.files.length).toBeGreaterThanOrEqual(2);
    expect(h.last()["final"]).toBe(true);
  });
});

describe("parseObservationLabel", () => {
  test("accepts exactly { extensionId, version } with non-empty strings", () => {
    expect(parseObservationLabel(JSON.stringify(LABEL))).toEqual(LABEL);
    for (const bad of [
      undefined,
      "",
      "not json",
      "[]",
      JSON.stringify({ extensionId: "a" }),
      JSON.stringify({ ...LABEL, extra: 1 }),
      JSON.stringify({ extensionId: "", version: "1" }),
      JSON.stringify({ extensionId: "a", version: 1 }),
    ]) {
      expect(parseObservationLabel(bad)).toBeNull();
    }
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "nimbus-obs-writer-"));
  roots.push(r);
  return r;
};

describe("writeObservationFileAtomic", () => {
  test("publishes the file and leaves no temp behind", () => {
    const dir = tempRoot();
    const path = join(dir, "ext_x.1.abcdef01.0.json");
    writeObservationFileAtomic(path, new TextEncoder().encode("{}"));
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(readdirSync(dir)).toEqual(["ext_x.1.abcdef01.0.json"]);
  });

  test("a stale .tmp from an earlier run with the same prefix does not stop a write", () => {
    const dir = tempRoot();
    const path = join(dir, "ext_x.1.abcdef01.0.json");
    const stale = observationTempPath(path, process.pid, "aaaa");
    writeFileSync(stale, "half a file");
    const suffixes = ["aaaa", "bbbb"];
    writeObservationFileAtomic(path, new TextEncoder().encode("{}"), () => suffixes.shift() ?? "");
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(existsSync(stale)).toBe(true);
  });

  test("the temp name is <prefix>.<seq>.<pid>.<4 hex>.tmp", () => {
    expect(observationTempPath("/o/p.7.json", 42, "beef")).toBe("/o/p.7.42.beef.tmp");
  });
});

/**
 * The wrapper's last window when the gateway stops it. A spawned wrapper, with a stand-in runner
 * that spawns its child unconfined, so this runs wherever SIGTERM runs a handler, sandbox or not.
 */
const WRAPPER_FIXTURE = resolve(
  import.meta.dir,
  "../../../test/fixtures/sandbox-wrapper-observed.ts",
);

/**
 * `Bun.spawn`, not `node:child_process`: a node spawn in a macOS test worker can lose its child's
 * exit and hang past `--timeout`.
 */
async function waitForExit(child: Bun.Subprocess, ms: number): Promise<number | null> {
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  try {
    await child.exited;
    return child.signalCode === null ? child.exitCode : null;
  } finally {
    clearTimeout(timer);
  }
}

function startWrapper(dir: string, mode: "stay" | "exit") {
  const ready = join(dir, "ready");
  const wrapper = Bun.spawn([process.execPath, WRAPPER_FIXTURE, ready, mode], {
    env: {
      ...process.env,
      [SANDBOX_POLICY_ENV]: JSON.stringify({
        id: "obs-test",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }),
      [SANDBOX_CWD_ENV]: join(dir, "cwd"),
      [SANDBOX_OBSERVATION_FILE_ENV]: join(dir, "ext_weather.1000.deadbeef"),
      [SANDBOX_OBSERVATION_LABEL_ENV]: JSON.stringify(LABEL),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { wrapper, ready };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(path)).toBe(true);
}

/** The run's one file: final, labelled, holding what the stand-in reported. */
function expectOneFinalFile(dir: string): void {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toEqual(["ext_weather.1000.deadbeef.0.json"]);
  const body = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")) as Record<
    string,
    unknown
  >;
  expect(body["final"]).toBe(true);
  expect(body["runStart"]).toBe(true);
  expect(body["label"]).toEqual(LABEL);
  expect(body["entries"]).toEqual([{ o: "used", h: "api.github.com", p: 443, n: 1 }]);
}

describe("the wrapper's observation", () => {
  test("the child's own exit writes the final file, and its environment lacks the channel", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "exit");
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    await waitForFile(ready);
    expect(readFileSync(ready, "utf8")).toBe("absent");
    expectOneFinalFile(dir);
  }, 70_000);
});

describe.skipIf(process.platform === "win32")("the wrapper's signal handlers", () => {
  test("SIGTERM to the wrapper still leaves a final file", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "stay");
    await waitForFile(ready);
    wrapper.kill("SIGTERM");
    expect(await waitForExit(wrapper, 30_000)).toBe(143);
    expect(readFileSync(ready, "utf8")).toBe("absent");
    expectOneFinalFile(dir);
  }, 70_000);
});

/**
 * Why the case above skips on Windows, proved rather than assumed: `process.kill(pid, "SIGTERM")`
 * there terminates the process outright, and no handler runs, so no wrapper code can write on it.
 */
describe.skipIf(process.platform !== "win32")("SIGTERM on Windows", () => {
  test("runs no handler, so the signal case cannot run here", async () => {
    const dir = tempRoot();
    const marker = join(dir, "handled");
    const ready = join(dir, "ready");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const fs=require("fs");process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(marker)},"x");process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},"");setInterval(()=>{},1000);`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready)).toBe(true);
    child.kill("SIGTERM");
    await waitForExit(child, 30_000);
    expect(existsSync(marker)).toBe(false);
  }, 70_000);
});
