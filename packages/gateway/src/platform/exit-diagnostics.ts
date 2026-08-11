import { appendFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";

import { processEnvGet } from "./env-access.ts";
import { platformDailyLogPath } from "./gateway-log-file.ts";

/**
 * Why this module exists
 * ----------------------
 * Before it, the gateway's ONLY process-level hooks were SIGTERM and SIGINT, and the only code
 * that logged anything about termination was the `shutdown()` path those two signals reach. On
 * Windows neither signal is deliverable to the detached, console-less gateway that `nimbus start`
 * spawns, so in practice NOTHING was ever logged about why the process ended — the daily log just
 * stopped mid-line and the next line was a fresh spawn banner.
 *
 * Every record here is written with `appendFileSync`. The daily pino logger uses
 * `pino.destination({ sync: false })`, whose buffered final write is exactly the one lost when a
 * process dies abruptly — i.e. precisely the record that matters. Diagnostics must not share that
 * fate, so they bypass pino and write straight to the same file, in pino's own line shape.
 */

export const LIFECYCLE_LOGGER_NAME = "gateway-lifecycle";

export type LifecycleEvent =
  | "boot"
  | "heartbeat"
  | "before_exit"
  | "process_exit"
  | "uncaught_exception"
  | "unhandled_rejection";

export type LifecycleWriter = (line: string) => void;

export type LifecycleContext = {
  readonly pid: number;
  readonly hostname: string;
  readonly now: () => number;
};

/**
 * One pino-shaped JSON line. Keeping pino's field names (`level`/`time`/`pid`/`hostname`/`msg`)
 * means the greps already used against this log — `'"level":(50|60)'` and friends — match these
 * records too, instead of needing a second, differently-shaped thing to search for.
 */
export function formatLifecycleLine(
  ctx: LifecycleContext,
  level: number,
  event: LifecycleEvent,
  msg: string,
  extra?: Readonly<Record<string, unknown>>,
): string {
  const rec: Record<string, unknown> = {
    level,
    time: ctx.now(),
    pid: ctx.pid,
    hostname: ctx.hostname,
    name: LIFECYCLE_LOGGER_NAME,
    event,
    ...extra,
    msg,
  };
  // JSON.stringify escapes embedded newlines, so a stack trace stays on one line.
  return `${JSON.stringify(rec)}\n`;
}

/** A synchronous appender. Never throws: a diagnostics failure must not end the gateway. */
export function createLifecycleWriter(logPath: string): LifecycleWriter {
  return (line: string): void => {
    try {
      appendFileSync(logPath, line, "utf8");
    } catch {
      /* best-effort — a log we cannot write is not a reason to die */
    }
  };
}

/**
 * The daily log the CLI is already appending its spawn banner to. `NIMBUS_GATEWAY_LOG_PATH` is set
 * by `spawnGateway()` and is authoritative when present, so the lifecycle records land in the exact
 * file the banner did; otherwise fall back to the platform's own daily-log path.
 */
export function resolveLifecycleLogPath(): string | null {
  const fromEnv = processEnvGet("NIMBUS_GATEWAY_LOG_PATH");
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return platformDailyLogPath();
}

export type ProcessLifecycleHost = {
  readonly pid: number;
  on(event: string, listener: (...args: never[]) => void): unknown;
  memoryUsage(): { rss: number; heapUsed: number; external: number };
  exit(code: number): never;
};

export type TimerHandle = { unref(): void };
export type SetIntervalFn = (fn: () => void, ms: number) => TimerHandle;
export type ClearIntervalFn = (handle: TimerHandle) => void;

export type GatewayLifecycleDiagnosticsOptions = {
  readonly host: ProcessLifecycleHost;
  readonly write: LifecycleWriter;
  readonly hostname: string;
  readonly version: string;
  readonly now: () => number;
  /** `<= 0` disables the heartbeat. */
  readonly heartbeatMs: number;
  readonly setIntervalFn: SetIntervalFn;
  readonly clearIntervalFn: ClearIntervalFn;
  /** Service ids currently mid-sync, for correlating a death with sync activity. */
  readonly activity?: () => readonly string[];
  /**
   * Extra per-heartbeat fields. Carries the embedding runtime's state: a native crash inside the
   * embedding worker thread takes the whole process down with no JS handler able to run, so the
   * last heartbeat before the gap is the only place that can say what it was doing.
   */
  readonly extras?: () => Readonly<Record<string, unknown>>;
};

const MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round(bytes / MB);
}

function describeReason(reason: unknown): { reason: string; stack?: string } {
  if (reason instanceof Error) {
    const out: { reason: string; stack?: string } = { reason: `${reason.name}: ${reason.message}` };
    if (reason.stack !== undefined) {
      out.stack = reason.stack;
    }
    return out;
  }
  return { reason: String(reason) };
}

export function installGatewayLifecycleDiagnostics(opts: GatewayLifecycleDiagnosticsOptions): {
  stop: () => void;
} {
  const { host, write, now } = opts;
  const ctx: LifecycleContext = { pid: host.pid, hostname: opts.hostname, now };
  const startedAtMs = now();
  const emit = (
    level: number,
    event: LifecycleEvent,
    msg: string,
    extra?: Readonly<Record<string, unknown>>,
  ): void => {
    write(formatLifecycleLine(ctx, level, event, msg, extra));
  };
  const uptimeSec = (): number => Math.round((now() - startedAtMs) / 1000);

  emit(30, "boot", "gateway lifecycle diagnostics armed", {
    version: opts.version,
    heartbeatMs: opts.heartbeatMs,
  });

  // `beforeExit` fires ONLY when the event loop has drained — it does not fire for an explicit
  // process.exit(), a fatal error, or an external kill. That makes it the discriminator between
  // "the gateway ran out of work and returned to the OS" and "something ended it".
  let drained = false;
  host.on("beforeExit", (...args: never[]): void => {
    drained = true;
    emit(60, "before_exit", "gateway event loop drained — no work left to keep the process alive", {
      code: typeof args[0] === "number" ? args[0] : null,
      uptimeSec: uptimeSec(),
    });
  });

  // The catch-all. This fires for EVERY in-process exit — drain, process.exit(), fatal error.
  // If a future death leaves no `process_exit` record at all, the process did not exit itself:
  // it was terminated from outside (TerminateProcess / job-object kill / native abort), which no
  // in-process handler can observe. That absence is itself the diagnosis.
  host.on("exit", (...args: never[]): void => {
    const mem = host.memoryUsage();
    emit(60, "process_exit", "gateway process exiting", {
      code: typeof args[0] === "number" ? args[0] : null,
      drained,
      uptimeSec: uptimeSec(),
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
    });
  });

  // Registering these two suppresses Bun's own stderr dump, so the record below must carry the
  // full stack. Exit code 1 is preserved deliberately: this makes the death LOGGED, not survivable
  // — turning a fatal error into a swallowed one is a separate decision, not an observability fix.
  host.on("uncaughtException", (...args: never[]): void => {
    const d = describeReason(args[0]);
    emit(60, "uncaught_exception", "uncaught exception — gateway is exiting", {
      ...d,
      origin: typeof args[1] === "string" ? args[1] : null,
      uptimeSec: uptimeSec(),
    });
    host.exit(1);
  });

  host.on("unhandledRejection", (...args: never[]): void => {
    const d = describeReason(args[0]);
    emit(60, "unhandled_rejection", "unhandled promise rejection — gateway is exiting", {
      ...d,
      uptimeSec: uptimeSec(),
    });
    host.exit(1);
  });

  if (opts.heartbeatMs <= 0) {
    return { stop: (): void => {} };
  }

  // The ONLY evidence available when the process is killed from outside: a timestamped
  // "last seen alive" plus the memory trend leading up to it.
  const timer = opts.setIntervalFn(() => {
    const mem = host.memoryUsage();
    let syncing: readonly string[] = [];
    let extras: Readonly<Record<string, unknown>> = {};
    try {
      syncing = opts.activity?.() ?? [];
      extras = opts.extras?.() ?? {};
    } catch {
      /* neither the scheduler nor the embedding runtime is a dependency the heartbeat may fail on */
    }
    emit(30, "heartbeat", "gateway alive", {
      uptimeSec: uptimeSec(),
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
      syncing,
      ...extras,
    });
  }, opts.heartbeatMs);
  // Load-bearing: a ref'd interval would keep the event loop alive by itself, masking the very
  // drain that `beforeExit` exists to detect.
  timer.unref();

  return {
    stop: (): void => {
      opts.clearIntervalFn(timer);
    },
  };
}

export const DEFAULT_HEARTBEAT_MS = 60_000;

export function resolveHeartbeatMs(): number {
  const raw = processEnvGet("NIMBUS_HEARTBEAT_MS");
  if (raw === undefined || raw === "") {
    return DEFAULT_HEARTBEAT_MS;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_HEARTBEAT_MS;
}

/**
 * Production wiring: resolve the daily log, then arm the diagnostics against the real `process`.
 * Returns a no-op stopper when no log path can be resolved.
 */
export function armGatewayLifecycleDiagnostics(
  version: string,
  activity: () => readonly string[],
  extras: () => Readonly<Record<string, unknown>>,
): { stop: () => void } {
  const logPath = resolveLifecycleLogPath();
  if (logPath === null) {
    return { stop: (): void => {} };
  }
  return installGatewayLifecycleDiagnostics({
    host: process as unknown as ProcessLifecycleHost,
    write: createLifecycleWriter(logPath),
    hostname: osHostname(),
    version,
    now: () => Date.now(),
    heartbeatMs: resolveHeartbeatMs(),
    setIntervalFn: (fn, ms) => setInterval(fn, ms),
    clearIntervalFn: (t) => {
      clearInterval(t as unknown as ReturnType<typeof setInterval>);
    },
    activity,
    extras,
  });
}
