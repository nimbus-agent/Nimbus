import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import {
  createNetworkObservationWriter,
  type NetworkObservationWriter,
  type ObservationOs,
  parseObservationLabel,
} from "./network-observation-writer.ts";
import { type ConnectionPoller, startConnectionPoller } from "./observe/connection-poller.ts";
import type { ConnectionSource } from "./observe/types.ts";
import {
  isSandboxWrapperOnlyEnv,
  parseSandboxPolicy,
  SANDBOX_CWD_ENV,
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "./sandbox-policy.ts";
import { createSandboxRunner, type SandboxRunner } from "./sandbox-runner.ts";
import { profileNameFor } from "./win32-argv.ts";

function signalNumber(signal: string): number {
  return (osConstants.signals as Record<string, number | undefined>)[signal] ?? 0;
}

function fatal(msg: string): never {
  process.stderr.write(`nimbus-sandbox-wrapper: ${msg}\n`);
  process.exit(2);
}

function observationOs(): ObservationOs | null {
  const p = process.platform;
  return p === "linux" || p === "darwin" || p === "win32" ? p : null;
}

/**
 * The observation writer, when the gateway asked for one. Null, and nothing observed, when the
 * prefix is unset; a set prefix with a label that is not `{ extensionId, version }` is said once on
 * stderr and observes nothing, since a file nobody can attribute would be rejected on ingest.
 * Observation never refuses the spawn.
 */
function observationWriter(): NetworkObservationWriter | null {
  const prefix = process.env[SANDBOX_OBSERVATION_FILE_ENV];
  if (prefix === undefined || prefix === "") return null;
  const label = parseObservationLabel(process.env[SANDBOX_OBSERVATION_LABEL_ENV]);
  const os = observationOs();
  if (label === null || os === null) {
    process.stderr.write(
      `nimbus-sandbox-wrapper: ${SANDBOX_OBSERVATION_LABEL_ENV} is not valid; not observing\n`,
    );
    return null;
  }
  return createNetworkObservationWriter({
    prefix,
    label,
    os,
  });
}

/** The wrapper's environment less what is the wrapper's alone: the policy wire and every wrapper-only key. */
export function wrapperChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV || isSandboxWrapperOnlyEnv(k)) continue;
    if (v !== undefined) childEnv[k] = v;
  }
  return childEnv;
}

/** Opens the connection source for one spawned child: Windows by its AppContainer, macOS by its tree. */
export type OpenConnectionSource = (
  policy: SandboxPolicy,
  child: ChildProcess,
) => ConnectionSource | { error: string };

export type SandboxWrapperDeps = {
  /** Tests only. Production passes nothing and gets the platform's runner. */
  createRunner?: () => Promise<SandboxRunner>;
  /** Tests only. Production opens the runner platform's own source. */
  openConnectionSource?: OpenConnectionSource;
  /** Tests only: the declared-name lookup. Production uses the OS resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Tests only: the poller's period. */
  pollPeriodMs?: number;
  /** Tests only: loads the platform's opener. Production imports the platform's source module. */
  loadConnectionSourceOpener?: (platform: "win32" | "darwin") => Promise<OpenConnectionSource>;
};

/** The platform's own opener, from its source module (loaded only on that platform). */
async function platformOpener(platform: "win32" | "darwin"): Promise<OpenConnectionSource> {
  if (platform === "win32") {
    const { openWin32ConnectionSource } = await import("./observe/win32-connections.ts");
    return (p) => openWin32ConnectionSource({ profileName: profileNameFor(p) });
  }
  const { openDarwinConnectionSource } = await import("./observe/darwin-connections.ts");
  // sandbox-exec execs the command in place, so the child's pid is the tree's root.
  return (_p, child) =>
    child.pid === undefined
      ? { error: "the child has no pid" }
      : openDarwinConnectionSource({ rootPid: child.pid });
}

/**
 * The source opener when this spawn is one the poller observes: Windows or macOS, a writer to
 * report to, and a policy that declares network (with none there is nothing to match, and the
 * sandbox lets nothing out). Loaded before the spawn, so opening it in the child's `spawn` event is
 * synchronous and ahead of file 0. Linux is observed by its forwarder instead. Called only through
 * {@link safeConnectionSourceOpener}, so a load that fails never stops the child from starting.
 */
async function connectionSourceOpener(
  platform: SandboxRunner["platform"],
  policy: SandboxPolicy,
  deps: SandboxWrapperDeps,
): Promise<OpenConnectionSource | null> {
  if (platform === "linux" || policy.permissions.network.length === 0) return null;
  if (deps.openConnectionSource !== undefined) return deps.openConnectionSource;
  return (deps.loadConnectionSourceOpener ?? platformOpener)(platform);
}

/** {@link connectionSourceOpener}, where any failure means "not observing", never a refused spawn. */
async function safeConnectionSourceOpener(
  platform: SandboxRunner["platform"],
  policy: SandboxPolicy,
  deps: SandboxWrapperDeps,
): Promise<OpenConnectionSource | null> {
  try {
    return await connectionSourceOpener(platform, policy, deps);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    process.stderr.write(`nimbus-sandbox-wrapper: not observing the network: ${why}\n`);
    return null;
  }
}

/**
 * Opens the source and starts the poller for a child that has just started. The run is marked
 * observed only once the source opened, and before the caller's `writer.start()` writes file 0; a
 * source that fails to open says so once on stderr and leaves the run unobserved. Never throws:
 * observation never refuses or breaks the child.
 */
function observeConnections(
  open: OpenConnectionSource,
  policy: SandboxPolicy,
  child: ChildProcess,
  writer: NetworkObservationWriter,
  deps: SandboxWrapperDeps,
): ConnectionPoller | null {
  let source: ConnectionSource | { error: string };
  try {
    source = open(policy, child);
  } catch (e) {
    source = { error: (e as Error).message };
  }
  if ("error" in source) {
    process.stderr.write(`nimbus-sandbox-wrapper: not observing the network: ${source.error}\n`);
    return null;
  }
  writer.markObserved();
  return startConnectionPoller({
    source,
    declared: policy.permissions.network,
    observer: writer,
    ...(deps.resolveHost === undefined ? {} : { resolve: deps.resolveHost }),
    ...(deps.pollPeriodMs === undefined ? {} : { periodMs: deps.pollPeriodMs }),
  });
}

/**
 * The `__nimbus-sandbox` role of the gateway executable: re-exec the requested command inside the
 * platform sandbox. `args` is everything after the sentinel — the original command followed by its
 * own arguments.
 */
export async function runSandboxWrapper(
  args: readonly string[],
  deps: SandboxWrapperDeps = {},
): Promise<never> {
  if (args.length < 1) {
    fatal("usage: <gateway> __nimbus-sandbox <cmd> [...args]");
  }
  const originalCmd = args[0];
  if (originalCmd === undefined) {
    fatal("missing original command");
  }
  const originalArgs = args.slice(1);

  const policyJson = process.env[SANDBOX_POLICY_ENV];
  if (policyJson === undefined || policyJson === "") {
    fatal(`${SANDBOX_POLICY_ENV} not set`);
  }
  const cwd = process.env[SANDBOX_CWD_ENV];
  if (cwd === undefined || cwd === "") {
    fatal(`${SANDBOX_CWD_ENV} not set`);
  }

  let policy: SandboxPolicy;
  try {
    policy = parseSandboxPolicy(policyJson);
  } catch (e) {
    fatal(`invalid ${SANDBOX_POLICY_ENV}: ${(e as Error).message}`);
  }

  const childEnv = wrapperChildEnv(process.env);

  // The per-policy leaf (spec § A) is created here, at the single point every wrapped spawn passes
  // through, and BEFORE the runner canonicalises it: `canonical-path.ts` falls back to the input
  // spelling for a path that does not exist, which would apply the Windows ACE to the wrong name.
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (e) {
    fatal(`cannot create sandbox working directory ${cwd}: ${(e as Error).message}`);
  }

  const runner = await (
    deps.createRunner ?? (() => createSandboxRunner({ forwarderStartProbe: false }))
  )();
  const writer = observationWriter();
  const openSource =
    writer === null ? null : await safeConnectionSourceOpener(runner.platform, policy, deps);
  let child: ChildProcess;
  try {
    child = runner.spawn(originalCmd, originalArgs, {
      policy,
      env: childEnv,
      cwd,
      stdio: "inherit",
      ...(writer === null ? {} : { observer: writer }),
    });
  } catch (e) {
    // A refused spawn ran nothing. The writer was never started, so no file was written and no run
    // is counted.
    fatal((e as Error).message);
  }

  // File 0 only once the child really started. A child that fails to start emits `error` instead of
  // `spawn`, so the writer stays unstarted, its `close` below writes nothing, and no run is counted.
  // On Windows and macOS the connection poller starts here too, and marks the run observed before
  // file 0 is written, so every file of the run says so.
  let poller: ConnectionPoller | null = null;
  child.once("spawn", () => {
    if (writer !== null && openSource !== null) {
      poller = observeConnections(openSource, policy, child, writer, deps);
    }
    writer?.start();
  });

  // The final window is written from the process's `exit`, which every way out reaches: the child's
  // exit below and the signal handlers. It must run AFTER the forwarder session closes, since
  // closing reports every relay still open, so a connection held for the whole run still counts.
  // The session registered its own `exit` listener inside `runner.spawn`, above, so it runs first.
  process.once("exit", () => writer?.close());

  // Explicit, and from the child's own exit: a dial pending on a blackholed address would keep the
  // event loop alive, and with it the MCP client's pipe, long after the child has gone.
  // The poller stops first: its last, synchronous poll reports into the writer before `process.exit`
  // runs the writer's `close`, so a connection still open at the end reaches the final file.
  child.on("exit", (code, signal) => {
    poller?.stop();
    process.exit(signal === null ? (code ?? 1) : 128 + signalNumber(signal));
  });
  // A signal's default action skips `process.exit`, so the forwarder's socket directory would stay
  // behind every time the gateway stopped a connector. `--die-with-parent` still takes the child.
  // `process.exit` runs the `exit` listeners synchronously, the observation writer's among them, so
  // a stopped extension's last window is still written.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      poller?.stop();
      process.exit(128 + signalNumber(signal));
    });
  }
  child.on("error", (err) => {
    fatal(`child spawn failed: ${err.message}`);
  });

  return new Promise<never>(() => {});
}
