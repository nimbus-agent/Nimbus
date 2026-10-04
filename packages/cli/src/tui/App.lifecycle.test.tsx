/**
 * App behaviour that `App.test.tsx` cannot reach through ink-testing-library: terminal-size
 * handling (that library's stdout is a fixed 100 columns with no `rows` at all), the timers
 * (Ctrl+C hint and double-press window, the reconnect backoff loop) and the failure arms of the
 * submit and consent paths — plus behaviour that file reaches but never pins: malformed stream
 * payloads, the sub-task reset on a new query, and what a mid-stream Ctrl+C does to the stream.
 *
 * The App is rendered with ink's own `render` over a stdout whose size the test controls,
 * including "unknown" (`undefined`). Timers are bun's fake timers, enabled only after mount and
 * always restored; every wait is an event-loop flush, never a wall-clock sleep.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render as inkRender } from "ink";

import { App } from "./App.tsx";
import {
  CANCEL_HINT_DURATION_MS,
  DOUBLE_CTRL_C_WINDOW_MS,
  MIN_HEIGHT_THRESHOLD,
  NARROW_LAYOUT_COLUMN_THRESHOLD,
  RECONNECT_BACKOFF_MS,
} from "./constants.ts";
import { IpcContext, type IpcContextValue } from "./ipc-context.ts";
import { type StubClientOptions, StubIpcClient } from "./test-helpers/stub-client.ts";
import { makeHistoryPath } from "./testing/context.ts";

interface TerminalSize {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

const WIDE: TerminalSize = { columns: 120, rows: 40 };
const CANCEL_HINT = "Press again within 2s to exit";
const DISCONNECTED_BANNER = "Gateway disconnected";

/** A stdout whose size the test sets — including `undefined`, i.e. "the terminal did not say". */
class SizedStdout extends EventEmitter {
  columns: number | undefined;
  rows: number | undefined;
  private readonly frames: string[] = [];

  constructor(size: TerminalSize) {
    super();
    this.columns = size.columns;
    this.rows = size.rows;
  }

  readonly write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };

  lastFrame(): string {
    return stripVTControlCharacters(this.frames.at(-1) ?? "");
  }
}

/** The stdin surface ink touches; the App's input handler only listens for `data`. */
class KeyboardStdin extends EventEmitter {
  readonly isTTY = true;
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): null {
    return null;
  }
}

interface LogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly fields: Record<string, unknown>;
  readonly msg: string;
}

function recordingLogger(into: LogRecord[]): IpcContextValue["logger"] {
  const at =
    (level: LogRecord["level"]) =>
    (fields: Record<string, unknown>, msg: string): void => {
      into.push({ level, fields, msg });
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  } as unknown as IpcContextValue["logger"];
}

interface RenderedApp {
  readonly stdout: SizedStdout;
  readonly logs: LogRecord[];
  exits(): number;
  frame(): string;
  type(text: string): void;
  resize(size: TerminalSize): void;
  unmount(): void;
}

const cleanups: Array<() => void> = [];

function renderApp(client: StubIpcClient, size: TerminalSize = WIDE): RenderedApp {
  const history = makeHistoryPath("nimbus-tui-lifecycle-");
  const stdout = new SizedStdout(size);
  const stdin = new KeyboardStdin();
  const logs: LogRecord[] = [];
  let exitCount = 0;
  const context: IpcContextValue = { client: client.asClient(), logger: recordingLogger(logs) };
  const instance = inkRender(
    <IpcContext.Provider value={context}>
      <App
        historyPath={history.path}
        onExit={() => {
          exitCount += 1;
        }}
      />
    </IpcContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new SizedStdout({}) as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  let unmounted = false;
  const unmount = (): void => {
    if (!unmounted) {
      unmounted = true;
      instance.unmount();
    }
  };
  cleanups.push(() => {
    unmount();
    history.cleanup();
  });
  return {
    stdout,
    logs,
    exits: () => exitCount,
    frame: () => stdout.lastFrame(),
    type: (text) => {
      stdin.emit("data", text);
    },
    resize: (next) => {
      stdout.columns = next.columns;
      stdout.rows = next.rows;
      stdout.emit("resize");
    },
    unmount,
  };
}

/**
 * Let pending promise continuations and React's passive effects run, without moving the clock.
 * React schedules effects with `setImmediate`, which bun's fake timers leave real, so this works
 * identically with real and fake timers. (Not `advanceTimersByTime(0)`: on bun 1.3.14 that fires
 * a timer still 1 ms in the future, which would blur every "not yet" assertion below.)
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Column of the right pane's top-left border corner; -1 when the panes are not boxed. */
function borderColumn(frame: string): number {
  const line = frame.split("\n").find((l) => l.includes("┌"));
  return line === undefined ? -1 : line.indexOf("┌");
}

/** Where the boxed right pane starts for a terminal `cols` wide (the App's own clamp). */
function expectedBorderColumn(cols: number): number {
  return Math.min(Math.max(cols - 32, 40), 120);
}

const BASE_RESULTS: Readonly<Record<string, unknown>> = {
  "connector.listStatus": [],
  "watcher.list": [],
  "engine.askStream": { streamId: "s-test" },
  "consent.respond": { ok: true },
};

/** A stub whose `connect()` follows a script — the reconnect loop's only gateway touch-point. */
class ScriptedConnectStub extends StubIpcClient {
  connectCalls = 0;
  private readonly script: ReadonlyArray<() => Promise<void>>;

  constructor(options: StubClientOptions, script: ReadonlyArray<() => Promise<void>> = []) {
    super(options);
    this.script = script;
  }

  override connect(): Promise<void> {
    const step = this.script[this.connectCalls];
    this.connectCalls += 1;
    return step === undefined ? Promise.resolve() : step();
  }
}

/** A gateway whose every `engine.askStream` dies with a transport error. */
function droppingStub(script: ReadonlyArray<() => Promise<void>> = []): ScriptedConnectStub {
  return new ScriptedConnectStub(
    { results: BASE_RESULTS, errors: { "engine.askStream": new Error("ECONNRESET") } },
    script,
  );
}

let origIsTty: PropertyDescriptor | undefined;
let origColumns: PropertyDescriptor | undefined;
let origRows: PropertyDescriptor | undefined;

/**
 * Put an own property back exactly as it was. A runner whose stdout is piped (every CI run) has
 * NO own `isTTY`/`columns`/`rows`, so "as it was" means DELETED — restoring only when a descriptor
 * existed would leave the pin behind as a non-writable 120x40 for every later file in the process.
 */
function restoreOwnProperty(
  target: object,
  key: string,
  original: PropertyDescriptor | undefined,
): void {
  if (original === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, original);
  }
}

beforeEach(() => {
  // Ink falls back to the process's own terminal size whenever the stdout above leaves a
  // dimension unset; pin it so that fallback never reaches the runner's real terminal.
  origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
});

afterEach(() => {
  try {
    // Unmount first, so effect cleanups clear their timers in the world that created them.
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  } finally {
    // Never leak fake timers, or the pinned terminal size, into the next file of a combined run,
    // even if a cleanup threw.
    if (jest.isFakeTimers()) {
      jest.useRealTimers();
    }
    restoreOwnProperty(process.stdout, "isTTY", origIsTty);
    restoreOwnProperty(process.stdout, "columns", origColumns);
    restoreOwnProperty(process.stdout, "rows", origRows);
  }
});

describe("terminal size", () => {
  test("below the narrow threshold the status panes sit under the results, unboxed", async () => {
    const narrowCols = NARROW_LAYOUT_COLUMN_THRESHOLD - 20;
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), {
      columns: narrowCols,
      rows: 40,
    });
    await flush();
    const frame = app.frame();
    expect(borderColumn(frame)).toBe(-1);
    expect(frame).not.toContain("│");
    // Still all three panes — narrow changes the arrangement, not the content.
    expect(frame).toContain("Connectors");
    expect(frame).toContain("Watchers");
    expect(frame).toContain("Sub-Tasks");
  });

  test("exactly NARROW_LAYOUT_COLUMN_THRESHOLD columns is wide; one column fewer is narrow", async () => {
    // The edge itself, named here: App.test.tsx only pins it incidentally, because
    // ink-testing-library's fixed 100-column stdout happens to equal the threshold.
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), {
      columns: NARROW_LAYOUT_COLUMN_THRESHOLD,
      rows: 40,
    });
    await flush();
    expect(borderColumn(app.frame())).toBe(expectedBorderColumn(NARROW_LAYOUT_COLUMN_THRESHOLD));

    app.resize({ columns: NARROW_LAYOUT_COLUMN_THRESHOLD - 1, rows: 40 });
    await flush();
    expect(borderColumn(app.frame())).toBe(-1);
  });

  test("BUG-004: on a very wide terminal the left pane is capped, so the status pane sits beside it", async () => {
    // 250 columns was the reported terminal. Uncapped, the left pane would take 250 - 32 = 218
    // columns and push the status pane out to the far edge.
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), { columns: 250, rows: 40 });
    await flush();
    expect(borderColumn(app.frame())).toBe(120);
  });

  test("an unreported width and height fall back to 120x40: boxed layout, no exit", async () => {
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), {});
    await flush();
    expect(borderColumn(app.frame())).toBe(expectedBorderColumn(120));
    expect(app.exits()).toBe(0);
  });

  test("a resize re-lays the panes out, and an unreported size falls back again", async () => {
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), WIDE);
    await flush();
    expect(borderColumn(app.frame())).toBe(expectedBorderColumn(120));

    app.resize({ columns: 80, rows: 40 });
    await flush();
    expect(borderColumn(app.frame())).toBe(-1);

    app.resize({ columns: 150, rows: 40 });
    await flush();
    expect(borderColumn(app.frame())).toBe(expectedBorderColumn(150));

    app.resize({});
    await flush();
    expect(borderColumn(app.frame())).toBe(expectedBorderColumn(120));
    expect(app.exits()).toBe(0);

    // The resize listener goes away with the component.
    expect(app.stdout.listenerCount("resize")).toBe(1);
    app.unmount();
    expect(app.stdout.listenerCount("resize")).toBe(0);
  });

  test("a terminal shorter than MIN_HEIGHT_THRESHOLD at mount exits, logging the height", async () => {
    const rows = MIN_HEIGHT_THRESHOLD - 10;
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), { columns: 120, rows });
    await flush();
    expect(app.exits()).toBe(1);
    expect(app.logs.filter((l) => l.fields["event"] === "tui.short-terminal-exit")).toEqual([
      {
        level: "info",
        fields: { event: "tui.short-terminal-exit", rows },
        msg: "exiting for short terminal",
      },
    ]);
  });

  test("exactly MIN_HEIGHT_THRESHOLD rows is tall enough", async () => {
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), {
      columns: 120,
      rows: MIN_HEIGHT_THRESHOLD,
    });
    await flush();
    expect(app.exits()).toBe(0);
    expect(app.logs.some((l) => l.fields["event"] === "tui.short-terminal-exit")).toBe(false);
  });

  test("a zero-row report means 'unknown', never 'too short' — a real short resize still exits", async () => {
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }), { columns: 120, rows: 0 });
    await flush();
    expect(app.exits()).toBe(0);

    app.resize({ columns: 120, rows: 0 });
    await flush();
    expect(app.exits()).toBe(0);

    app.resize({ columns: 120, rows: 5 });
    await flush();
    expect(app.exits()).toBe(1);
    expect(app.logs.filter((l) => l.fields["event"] === "tui.short-terminal-exit")).toEqual([
      {
        level: "info",
        fields: { event: "tui.short-terminal-exit", rows: 5 },
        msg: "exiting for short terminal",
      },
    ]);
  });
});

describe("NIMBUS_BENCH first-frame marker", () => {
  async function stderrWritesDuringMount(bench: string | undefined): Promise<string[]> {
    const saved = process.env["NIMBUS_BENCH"];
    if (bench === undefined) {
      Reflect.deleteProperty(process.env, "NIMBUS_BENCH");
    } else {
      process.env["NIMBUS_BENCH"] = bench;
    }
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }));
      await flush();
      // A re-render must not repeat it: the marker is for the FIRST frame only.
      app.resize({ columns: 110, rows: 40 });
      await flush();
    } finally {
      process.stderr.write = original;
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "NIMBUS_BENCH");
      } else {
        process.env["NIMBUS_BENCH"] = saved;
      }
    }
    return writes;
  }

  test("is written to stderr exactly once when NIMBUS_BENCH=1", async () => {
    const writes = await stderrWritesDuringMount("1");
    expect(writes.filter((w) => w === "[tui] first-frame\n")).toHaveLength(1);
  });

  test("is not written when NIMBUS_BENCH is unset or not '1'", async () => {
    expect(await stderrWritesDuringMount(undefined)).not.toContain("[tui] first-frame\n");
    expect(await stderrWritesDuringMount("true")).not.toContain("[tui] first-frame\n");
  });
});

describe("notification payload validation", () => {
  test("a batch whose requests hold a non-object entry is ignored; a valid one is shown", async () => {
    const stub = new StubIpcClient({ results: BASE_RESULTS });
    const app = renderApp(stub);
    await flush();
    stub.emit("agent.hitlBatch", { batchId: "b-null", requests: [null] });
    stub.emit("agent.hitlBatch", { batchId: "b-str", requests: ["github.create_pr"] });
    stub.emit("agent.hitlBatch", {
      batchId: "b-mixed",
      requests: [{ actionId: "a-1", action: "github.create_pr", params: {} }, 42],
    });
    await flush();
    expect(app.frame()).not.toContain("consent required");
    expect(app.frame()).toContain("nimbus>");

    stub.emit("agent.hitlBatch", {
      batchId: "b-ok",
      requests: [{ actionId: "a-1", action: "github.create_pr", params: { repo: "acme/api" } }],
    });
    await flush();
    expect(app.frame()).toContain("consent required");
    expect(app.frame()).toContain("(1 of 1 pending)");
  });

  test("malformed stream notifications are ignored; the stream carries on to its real end", async () => {
    const stub = new StubIpcClient({ results: BASE_RESULTS });
    const app = renderApp(stub);
    await flush();
    app.type("question\r");
    await flush();
    // Neither is a valid payload: a token with no text, an error with no message.
    stub.emit("engine.streamToken", { streamId: "s-test" });
    stub.emit("engine.streamError", { streamId: "s-test" });
    await flush();
    expect(app.frame()).not.toContain("undefined");
    expect(app.frame()).not.toContain("❌");

    // Still the same stream: its real token and its real end both land.
    stub.emit("engine.streamToken", { streamId: "s-test", text: "the real answer" });
    stub.emit("engine.streamDone", { streamId: "s-test" });
    await flush();
    const frame = app.frame();
    expect(frame.split("\n").filter((l) => l.includes("the real answer"))).toHaveLength(1);
    expect(frame).not.toContain("undefined");
    expect(frame).not.toContain("❌");
  });
});

describe("a new query", () => {
  test("clears the previous query's sub-tasks", async () => {
    const stub = new StubIpcClient({ results: BASE_RESULTS });
    const app = renderApp(stub);
    await flush();
    stub.emit("agent.subTaskProgress", {
      subTaskId: "t-1",
      name: "scan-prs",
      status: "running",
      progress: 0.5,
    });
    await flush();
    expect(app.frame()).toContain("scan-prs");

    app.type("next question\r");
    await flush();
    expect(app.frame()).not.toContain("scan-prs");
    expect(app.frame()).toContain("No sub-tasks running yet");
  });
});

/** A gateway whose `engine.askStream` rejects with a bare string rather than an Error. */
class NonErrorRejectingStub extends StubIpcClient {
  override call<T>(method: string, params?: unknown): Promise<T> {
    if (method === "engine.askStream") {
      this.calls.push({ method, params });
      return Promise.reject("socket hang up");
    }
    return super.call<T>(method, params);
  }
}

describe("failure arms of submit, stream and consent", () => {
  test("a non-Error submit rejection is logged as its text and drops to the disconnected state", async () => {
    const app = renderApp(new NonErrorRejectingStub({ results: BASE_RESULTS }));
    await flush();
    app.type("hello\r");
    await flush();
    expect(app.logs.filter((l) => l.fields["event"] === "tui.submit.error")).toEqual([
      {
        level: "debug",
        fields: { event: "tui.submit.error", err: "socket hang up" },
        msg: "submit failed",
      },
    ]);
    expect(app.frame()).toContain(DISCONNECTED_BANNER);
  });

  test("a stream error after partial output keeps the partial text, marked as an error", async () => {
    const stub = new StubIpcClient({ results: BASE_RESULTS });
    const app = renderApp(stub);
    await flush();
    app.type("question\r");
    await flush();
    stub.emit("engine.streamToken", { streamId: "s-test", text: "partial answer" });
    stub.emit("engine.streamError", { streamId: "s-test", error: "upstream reset" });
    await flush();
    const frame = app.frame();
    expect(frame).toContain("❌ partial answer");
    // Recorded once, as an error — not also as an ordinary reply line.
    expect(frame.split("\n").filter((l) => l.includes("partial answer"))).toHaveLength(1);
    expect(frame).toContain("nimbus>");
  });

  test("a failing consent.respond after the last decision is logged; the outcome still renders", async () => {
    const stub = new StubIpcClient({
      results: BASE_RESULTS,
      errors: { "consent.respond": new Error("gateway went away") },
    });
    const app = renderApp(stub);
    await flush();
    stub.emit("agent.hitlBatch", {
      batchId: "b-1",
      requests: [{ actionId: "a-1", action: "github.merge_pr", params: { num: 7 } }],
    });
    await flush();
    app.type("a");
    await flush();
    expect(stub.calls.filter((c) => c.method === "consent.respond")).toHaveLength(1);
    expect(app.logs.filter((l) => l.fields["event"] === "tui.consent.error")).toEqual([
      {
        level: "debug",
        fields: { event: "tui.consent.error", err: "Error: gateway went away" },
        msg: "consent failed",
      },
    ]);
    expect(app.frame()).toContain("✓ approved all");
    expect(app.frame()).not.toContain("consent required");
  });

  test("'q' rejects everything and exits even when that consent.respond fails", async () => {
    const stub = new StubIpcClient({
      results: BASE_RESULTS,
      errors: { "consent.respond": new Error("gateway went away") },
    });
    const app = renderApp(stub);
    await flush();
    stub.emit("agent.hitlBatch", {
      batchId: "b-q",
      requests: [
        { actionId: "a-1", action: "act1", params: {} },
        { actionId: "a-2", action: "act2", params: {} },
      ],
    });
    await flush();
    app.type("q");
    await flush();
    expect(app.exits()).toBe(1);
    expect(stub.calls.filter((c) => c.method === "consent.respond")).toEqual([
      {
        method: "consent.respond",
        params: {
          batchId: "b-q",
          decisions: [
            { actionId: "a-1", approved: false },
            { actionId: "a-2", approved: false },
          ],
        },
      },
    ]);
  });
});

describe("Ctrl+C", () => {
  test("the press-again hint clears after CANCEL_HINT_DURATION_MS", async () => {
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }));
    await flush();
    jest.useFakeTimers();
    app.type("\x03");
    await flush();
    expect(app.frame()).toContain(CANCEL_HINT);
    jest.advanceTimersByTime(CANCEL_HINT_DURATION_MS - 1);
    await flush();
    expect(app.frame()).toContain(CANCEL_HINT);
    jest.advanceTimersByTime(1);
    await flush();
    expect(app.frame()).not.toContain(CANCEL_HINT);
    expect(app.exits()).toBe(0);
  });

  test("Ctrl+C mid-stream abandons that stream: its late tokens and its end are ignored", async () => {
    const stub = new StubIpcClient({ results: BASE_RESULTS });
    const app = renderApp(stub);
    await flush();
    jest.useFakeTimers();
    app.type("long question\r");
    await flush();
    stub.emit("engine.streamToken", { streamId: "s-test", text: "partial" });
    await flush();
    app.type("\x03");
    await flush();
    expect(app.frame()).toContain("canceled by user");

    // The gateway is not told (no engine.cancelStream), so it keeps sending — and is not listened to.
    stub.emit("engine.streamToken", { streamId: "s-test", text: " LATE-TOKEN" });
    stub.emit("engine.streamDone", { streamId: "s-test" });
    await flush();
    const frame = app.frame();
    expect(frame).not.toContain("LATE-TOKEN");
    // What arrived before the cancel is kept, once.
    expect(frame.split("\n").filter((l) => l.includes("partial"))).toHaveLength(1);
    expect(app.exits()).toBe(0);
  });

  test("only a second press inside DOUBLE_CTRL_C_WINDOW_MS exits", async () => {
    const app = renderApp(new StubIpcClient({ results: BASE_RESULTS }));
    await flush();
    jest.useFakeTimers();
    app.type("\x03");
    jest.advanceTimersByTime(DOUBLE_CTRL_C_WINDOW_MS);
    app.type("\x03");
    await flush();
    // Exactly at the window's edge is too late: it counts as a fresh first press.
    expect(app.exits()).toBe(0);
    expect(app.frame()).toContain(CANCEL_HINT);
    jest.advanceTimersByTime(DOUBLE_CTRL_C_WINDOW_MS - 1);
    app.type("\x03");
    await flush();
    expect(app.exits()).toBe(1);
  });
});

describe("reconnect loop", () => {
  const [FIRST_BACKOFF_MS, SECOND_BACKOFF_MS] = RECONNECT_BACKOFF_MS;

  /** Mount, then lose the gateway on a submit — with fake timers already in charge. */
  async function disconnectedApp(stub: ScriptedConnectStub): Promise<RenderedApp> {
    const app = renderApp(stub);
    await flush();
    jest.useFakeTimers();
    app.type("hi\r");
    await flush();
    expect(app.frame()).toContain(DISCONNECTED_BANNER);
    return app;
  }

  test("reconnects once the first backoff step elapses — not before — and clears the banner", async () => {
    const stub = droppingStub();
    const app = await disconnectedApp(stub);
    jest.advanceTimersByTime(FIRST_BACKOFF_MS - 1);
    await flush();
    expect(stub.connectCalls).toBe(0);
    jest.advanceTimersByTime(1);
    await flush();
    expect(stub.connectCalls).toBe(1);
    expect(app.frame()).not.toContain(DISCONNECTED_BANNER);
    expect(app.frame()).toContain("nimbus>");
  });

  test("a failed attempt retries on the next, longer step; a later drop starts from the first step again", async () => {
    const stub = droppingStub([() => Promise.reject(new Error("ECONNREFUSED"))]);
    const app = await disconnectedApp(stub);
    jest.advanceTimersByTime(FIRST_BACKOFF_MS);
    await flush();
    expect(stub.connectCalls).toBe(1);
    expect(app.frame()).toContain(DISCONNECTED_BANNER);

    jest.advanceTimersByTime(SECOND_BACKOFF_MS - 1);
    await flush();
    expect(stub.connectCalls).toBe(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(stub.connectCalls).toBe(2);
    expect(app.frame()).not.toContain(DISCONNECTED_BANNER);

    // Reconnected: the backoff resets, so the next drop waits the FIRST step, not the third.
    app.type("again\r");
    await flush();
    expect(app.frame()).toContain(DISCONNECTED_BANNER);
    jest.advanceTimersByTime(FIRST_BACKOFF_MS);
    await flush();
    expect(stub.connectCalls).toBe(3);
    expect(app.frame()).not.toContain(DISCONNECTED_BANNER);
  });

  test("unmounting during a backoff wait cancels the pending attempt", async () => {
    const stub = droppingStub();
    const app = await disconnectedApp(stub);
    app.unmount();
    jest.advanceTimersByTime(RECONNECT_BACKOFF_MS.reduce((a, b) => a + b, 0));
    await flush();
    expect(stub.connectCalls).toBe(0);
  });

  test("a connect that fails after unmount schedules no further attempt", async () => {
    let failConnect: (reason: Error) => void = () => undefined;
    const stub = droppingStub([
      () =>
        new Promise<void>((_resolve, reject) => {
          failConnect = reject;
        }),
    ]);
    const app = await disconnectedApp(stub);
    jest.advanceTimersByTime(FIRST_BACKOFF_MS);
    await flush();
    expect(stub.connectCalls).toBe(1);

    app.unmount();
    failConnect(new Error("ECONNREFUSED"));
    await flush();
    // No retry timer was even armed …
    expect(jest.getTimerCount()).toBe(0);
    // … so however long we wait, nothing reconnects.
    jest.advanceTimersByTime(RECONNECT_BACKOFF_MS.reduce((a, b) => a + b, 0));
    await flush();
    expect(stub.connectCalls).toBe(1);
  });
});
