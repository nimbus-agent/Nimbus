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

function harness(over: Partial<NetworkObservationWriterOptions> = {}, start = true) {
  let clock = 1_000;
  const files: Written[] = [];
  const writer = createNetworkObservationWriter({
    prefix: "/obs/ext_weather.1000.deadbeef",
    label: LABEL,
    os: "linux",
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
  if (start) writer.start();
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

  test("writes nothing until started: a spawn that never starts leaves no run behind", () => {
    const h = harness({}, false);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    h.writer.close();
    h.writer.start();
    expect(h.files).toEqual([]);
  });

  test("start writes file 0 once, empty, so a run killed at once is still counted", () => {
    const h = harness({}, false);
    expect(h.files).toEqual([]);
    h.writer.start();
    h.writer.start();
    expect(h.files.map((f) => f.path)).toEqual(["/obs/ext_weather.1000.deadbeef.0.json"]);
    expect(h.last()).toEqual({
      v: 1,
      label: LABEL,
      seq: 0,
      runStart: true,
      os: "linux",
      networkObserved: false,
      fromMs: 1_000,
      toMs: 1_000,
      final: false,
      entries: [],
      dropped: 0,
    });
  });

  test("writes the exact body shape, and names the file <prefix>.<seq>.json", () => {
    const h = harness();
    h.tick(500);
    h.writer.markObserved();
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    expect(h.files[1]?.path).toBe("/obs/ext_weather.1000.deadbeef.1.json");
    expect(h.last()).toEqual({
      v: 1,
      label: LABEL,
      seq: 1,
      runStart: false,
      os: "linux",
      networkObserved: true,
      fromMs: 1_000,
      toMs: 1_500,
      final: false,
      entries: [{ o: "used", h: "api.github.com", p: 443, n: 1 }],
      dropped: 0,
    });
  });

  test("networkObserved is false until the runner marks it, then true in every later file", () => {
    const h = harness();
    h.writer.flush(false);
    h.writer.markObserved();
    h.writer.flush(false);
    h.writer.close();
    expect(h.files.map((f) => f.body["networkObserved"])).toEqual([false, false, true, true]);
  });

  test("a writer nobody marks says networkObserved false in every file", () => {
    const h = harness({ os: "win32" });
    h.writer.flush(false);
    h.writer.close();
    expect(h.files.map((f) => f.body["networkObserved"])).toEqual([false, false, false]);
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

  test("unmatched keeps an IPv4 or IPv6 literal verbatim, keyed by address and port, with counts", () => {
    const h = harness({ os: "win32" });
    h.writer.unmatched("203.0.113.7", 443);
    h.writer.unmatched("203.0.113.7", 443);
    h.writer.unmatched("203.0.113.7", 80);
    h.writer.unmatched("2001:db8::1", 443);
    h.writer.unmatched("::ffff:203.0.113.9", 443);
    h.writer.flush(false);
    expect(entriesOf(h.last())).toEqual([
      { o: "unmatched", h: "203.0.113.7", p: 443, n: 2 },
      { o: "unmatched", h: "2001:db8::1", p: 443, n: 1 },
      { o: "unmatched", h: "203.0.113.7", p: 80, n: 1 },
      { o: "unmatched", h: "::ffff:203.0.113.9", p: 443, n: 1 },
    ]);
    expect(h.last()["dropped"]).toBe(0);
  });

  test("unmatched drops anything that is not an IP literal into dropped, never sanitising it", () => {
    const h = harness({ os: "win32" });
    h.writer.unmatched("evil.example.com", 443);
    h.writer.unmatched("1.2.3.4\n", 443);
    h.writer.unmatched("", 443);
    h.writer.unmatched("203.0.113.7", 70_000);
    h.writer.flush(false);
    expect(entriesOf(h.last())).toEqual([]);
    expect(h.last()["dropped"]).toBe(4);
  });

  test("unmatched is bounded like the others, and a flood of it never hides a used connection", () => {
    const h = harness({ os: "win32" });
    for (let i = 0; i < 300; i += 1)
      h.writer.unmatched(`10.0.${String(i >> 8)}.${String(i & 255)}`, 443);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    const entries = entriesOf(h.last());
    expect(entries).toHaveLength(256);
    expect(entries[0]).toEqual({ o: "used", h: "api.github.com", p: 443, n: 1 });
    expect(h.last()["dropped"]).toBe(45);
  });

  test("a trim keeps used, then unmatched, then refused", () => {
    const h = harness({ os: "win32" });
    h.writer.refused("r.example.org");
    h.writer.unmatched("203.0.113.7", 443);
    h.writer.used("api.github.com", 443);
    h.writer.flush(false);
    expect(entriesOf(h.last()).map((e) => e.o)).toEqual(["used", "unmatched", "refused"]);
  });

  test("the body stays within 64 KiB with 256 entries of 253-character names", () => {
    const h = harness();
    for (let i = 0; i < 256; i += 1) {
      h.writer.refused(`${String(i).padStart(3, "0")}${"x".repeat(260)}`);
    }
    h.writer.flush(false);
    const file = h.files.at(-1);
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
    expect(h.files.map((f) => f.body["seq"])).toEqual([0, 1, 2, 3]);
    expect(h.files.map((f) => f.body["runStart"])).toEqual([true, false, false, false]);
    expect(h.files.map((f) => [f.body["fromMs"], f.body["toMs"]])).toEqual([
      [1_000, 1_000],
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
    expect(h.files).toHaveLength(2);
    expect(h.last()["final"]).toBe(true);
  });

  test("close never throws, even when building its file does", () => {
    let broken = false;
    const h = harness({
      now: () => {
        if (broken) throw new Error("clock gone");
        return 1_000;
      },
    });
    broken = true;
    expect(() => h.writer.close()).not.toThrow();
    expect(() => h.writer.close()).not.toThrow();
  });

  test("every file carries the label verbatim", () => {
    const h = harness();
    h.writer.flush(false);
    h.writer.flush(false);
    h.writer.close();
    expect(h.files.map((f) => f.body["label"])).toEqual([LABEL, LABEL, LABEL, LABEL]);
  });

  test("file 1441 is the stopped marker, and later events write nothing", () => {
    const h = harness();
    // File 0 was written at start.
    for (let i = 1; i < MAX_FILES; i += 1) h.writer.flush(false);
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

/** Each field at its cap in a 3-byte character: 990 bytes of UTF-8. */
const WIDE_LABEL = JSON.stringify({
  extensionId: "\u20ac".repeat(256),
  version: "\u20ac".repeat(64),
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
      JSON.stringify({ extensionId: "a".repeat(257), version: "1" }),
      JSON.stringify({ extensionId: "a", version: "1".repeat(65) }),
      // Each field within its own cap, the whole over 1 KiB of UTF-8.
      `${WIDE_LABEL}${" ".repeat(100)}`,
    ]) {
      expect(parseObservationLabel(bad)).toBeNull();
    }
    const longest = { extensionId: "a".repeat(256), version: "1".repeat(64) };
    // 990 bytes: within every cap, so only the padding above made it too long.
    expect(parseObservationLabel(WIDE_LABEL)).not.toBeNull();
    expect(parseObservationLabel(JSON.stringify(longest))).toEqual(longest);
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
    writeObservationFileAtomic(path, new TextEncoder().encode("{}"), {
      suffix: () => suffixes.shift() ?? "",
    });
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(existsSync(stale)).toBe(true);
  });

  test("a write that fails after creating its temp file leaves no .tmp behind", () => {
    const dir = tempRoot();
    const path = join(dir, "ext_x.1.abcdef01.0.json");
    const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    expect(() =>
      writeObservationFileAtomic(path, new TextEncoder().encode("{}"), {
        writeTemp: (temp) => {
          writeFileSync(temp, "half");
          throw full;
        },
      }),
    ).toThrow("no space left on device");
    expect(readdirSync(dir)).toEqual([]);
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

type WrapperMode = "stay" | "exit" | "refuse" | "error" | "poll" | "poll-fail" | "poll-load-fail";

function startWrapper(dir: string, mode: WrapperMode, observed = false, network: string[] = []) {
  const ready = join(dir, "ready");
  const argv = [process.execPath, WRAPPER_FIXTURE, ready, mode, ...(observed ? ["observed"] : [])];
  const wrapper = Bun.spawn(argv, {
    env: {
      ...process.env,
      [SANDBOX_POLICY_ENV]: JSON.stringify({
        id: "obs-test",
        permissions: { network, filesystem: { read: [], write: [] } },
      }),
      [SANDBOX_CWD_ENV]: join(dir, "cwd"),
      [SANDBOX_OBSERVATION_FILE_ENV]: join(dir, "ext_weather.1000.deadbeef"),
      [SANDBOX_OBSERVATION_LABEL_ENV]: JSON.stringify(LABEL),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { wrapper, ready };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(path)).toBe(true);
}

/**
 * The run's two files: file 0, written at start, and the final one. The final file holds the
 * connection the stand-in reports from its own exit listener, registered inside `spawn` as the real
 * forwarder session's is, so it lands only if the wrapper's writer closes after it.
 */
function expectRunFiles(dir: string, observed = false): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => (a < b ? -1 : 1));
  expect(files).toEqual(["ext_weather.1000.deadbeef.0.json", "ext_weather.1000.deadbeef.1.json"]);
  const [first, last] = files.map(
    (f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>,
  );
  expect(first?.["runStart"]).toBe(true);
  expect(first?.["final"]).toBe(false);
  expect(first?.["entries"]).toEqual([]);
  expect(last?.["runStart"]).toBe(false);
  expect(last?.["final"]).toBe(true);
  expect(last?.["networkObserved"]).toBe(observed);
  expect(last?.["label"]).toEqual(LABEL);
  expect(last?.["entries"]).toEqual([{ o: "used", h: "api.github.com", p: 443, n: 1 }]);
}

describe("the wrapper's observation", () => {
  test("the child's own exit writes the final file, and its environment lacks the channel", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "exit");
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    await waitForFile(ready);
    expect(readFileSync(ready, "utf8")).toBe("absent");
    expectRunFiles(dir);
  }, 70_000);

  test("a runner that marks the spawn observed makes the file say so", async () => {
    const dir = tempRoot();
    const { wrapper } = startWrapper(dir, "exit", true);
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    expectRunFiles(dir, true);
  }, 70_000);
});

/** The run's window files, parsed, in seq order. */
function runFiles(dir: string): Record<string, unknown>[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => (a < b ? -1 : 1))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
}

/**
 * The Windows/macOS poller in the real wrapper, with a fake source and resolver (the fixture's
 * `poll` mode). The source reports nothing until the child has exited, so the final file holds its
 * connections only because the wrapper's exit handler stops the poller, whose last poll is
 * synchronous, BEFORE `process.exit` runs the writer's close.
 */
describe("the wrapper's connection poller", () => {
  test("its last poll reaches the final file; the run is observed from file 0; only declared names are resolved", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "poll", false, [
      "api.github.com:443",
      "uploads.github.com",
    ]);
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    const files = runFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f["networkObserved"])).toEqual([true, true]);
    expect(files[0]?.["entries"]).toEqual([]);
    expect(files[1]?.["final"]).toBe(true);
    expect(files[1]?.["entries"]).toEqual([
      { o: "used", h: "api.github.com", p: 443, n: 1 },
      { o: "unmatched", h: "203.0.113.7", p: 443, n: 1 },
    ]);
    // I29 / I50 bound: the resolver saw the policy's declared names and nothing else.
    const resolved = readFileSync(`${ready}.resolved`, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect([...new Set(resolved)].sort((a, b) => (a < b ? -1 : 1))).toEqual([
      "api.github.com",
      "uploads.github.com",
    ]);
  }, 70_000);

  test("a source that fails to open leaves the run unobserved and the child unharmed", async () => {
    const dir = tempRoot();
    const { wrapper } = startWrapper(dir, "poll-fail", false, ["api.github.com:443"]);
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    const files = runFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f["networkObserved"])).toEqual([false, false]);
    expect(files[1]?.["entries"]).toEqual([]);
  }, 70_000);

  test("an opener that fails to load says so once, observes nothing, and the child still runs", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "poll-load-fail", false, ["api.github.com:443"]);
    const stderr = new Response(wrapper.stderr).text();
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    await waitForFile(ready);
    const files = runFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f["networkObserved"])).toEqual([false, false]);
    const lines = (await stderr)
      .split(/\r?\n/)
      .filter((l) => l.includes("not observing the network"));
    expect(lines).toEqual([
      "nimbus-sandbox-wrapper: not observing the network: the source module did not load",
    ]);
  }, 70_000);

  test("a policy that declares no network starts no poller and resolves nothing", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "poll", false, []);
    expect(await waitForExit(wrapper, 30_000)).toBe(0);
    const files = runFiles(dir);
    expect(files.map((f) => f["networkObserved"])).toEqual([false, false]);
    expect(files[1]?.["entries"]).toEqual([]);
    expect(existsSync(`${ready}.resolved`)).toBe(false);
  }, 70_000);
});

describe("a spawn that fails counts no run", () => {
  for (const mode of ["refuse", "error"] as const) {
    test(`a ${mode === "refuse" ? "refused spawn" : "child that emits error"} writes no window file`, async () => {
      const dir = tempRoot();
      const { wrapper } = startWrapper(dir, mode);
      expect(await waitForExit(wrapper, 30_000)).toBe(2);
      expect(readdirSync(dir).filter((f) => f.endsWith(".json") || f.endsWith(".tmp"))).toEqual([]);
    }, 70_000);
  }
});

describe.skipIf(process.platform === "win32")("the wrapper's signal handlers", () => {
  test("SIGTERM to the wrapper still leaves a final file", async () => {
    const dir = tempRoot();
    const { wrapper, ready } = startWrapper(dir, "stay");
    await waitForFile(ready);
    wrapper.kill("SIGTERM");
    expect(await waitForExit(wrapper, 30_000)).toBe(143);
    expect(readFileSync(ready, "utf8")).toBe("absent");
    expectRunFiles(dir);
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
        // A fixed script: the two paths arrive as argv, never inside the code.
        'const fs=require("fs");const [marker,ready]=process.argv.slice(-2);process.on("SIGTERM",()=>{fs.writeFileSync(marker,"x");process.exit(0)});fs.writeFileSync(ready,"");setInterval(()=>{},1000);',
        marker,
        ready,
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
