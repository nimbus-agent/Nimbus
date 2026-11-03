import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import {
  createNetworkObservationWriter,
  type NetworkObservationWriter,
  type ObservationOs,
  parseObservationLabel,
} from "./network-observation-writer.ts";
import {
  declaresNetwork,
  isSandboxWrapperOnlyEnv,
  parseSandboxPolicy,
  SANDBOX_CWD_ENV,
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "./sandbox-policy.ts";
import { createSandboxRunner, type SandboxRunner } from "./sandbox-runner.ts";

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
function observationWriter(policy: SandboxPolicy): NetworkObservationWriter | null {
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
    networkObserved: os === "linux" && declaresNetwork(policy),
  });
}

/** The wrapper's environment less what is the wrapper's alone: the policy wire and every wrapper-only key. */
function wrapperChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV || isSandboxWrapperOnlyEnv(k)) continue;
    if (v !== undefined) childEnv[k] = v;
  }
  return childEnv;
}

export type SandboxWrapperDeps = {
  /** Tests only. Production passes nothing and gets the platform's runner. */
  createRunner?: () => Promise<SandboxRunner>;
};

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
  let writer = observationWriter(policy);
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
    // A refused spawn ran nothing, so it leaves no run behind to count.
    writer = null;
    fatal((e as Error).message);
  }

  // The final window is written from the process's `exit`, which every way out reaches: the child's
  // exit below and the signal handlers. It must run AFTER the forwarder session closes, since
  // closing reports every relay still open, so a connection held for the whole run still counts.
  // The session registered its own `exit` listener inside `runner.spawn`, above, so it runs first.
  process.once("exit", () => writer?.close());

  // Explicit, and from the child's own exit: a dial pending on a blackholed address would keep the
  // event loop alive, and with it the MCP client's pipe, long after the child has gone.
  child.on("exit", (code, signal) => {
    process.exit(signal === null ? (code ?? 1) : 128 + signalNumber(signal));
  });
  // A signal's default action skips `process.exit`, so the forwarder's socket directory would stay
  // behind every time the gateway stopped a connector. `--die-with-parent` still takes the child.
  // `process.exit` runs the `exit` listeners synchronously, the observation writer's among them, so
  // a stopped extension's last window is still written.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => process.exit(128 + signalNumber(signal)));
  }
  child.on("error", (err) => {
    // A child that never started ran no network, so it leaves no run behind to count.
    writer = null;
    fatal(`child spawn failed: ${err.message}`);
  });

  return new Promise<never>(() => {});
}
