import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { CliExit } from "../lib/cli-exit.ts";
import { type LocalityReport, printLocalityPanel } from "../lib/locality-panel.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { defaultTourRunners, runTour, type TourRunners, type TourStep } from "../lib/run-tour.ts";
import { type StopResult, stopAndWaitForExit } from "../lib/stop-and-wait.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";
import type { ProveResult } from "./prove.ts";
import { runStart } from "./start.ts";

export interface DemoSeedSummary {
  readonly counts: { readonly people: number; readonly items: number };
  /** The demo tour, built gateway-side: `command` carries `--demo`, `args` never does. */
  readonly tour: readonly TourStep[];
  /** The gateway clock when seeding finished — the `since` edge of the demo's proof window. */
  readonly t0: number;
}

export interface DemoDeps {
  readonly paths: () => CliPlatformPaths;
  readonly stop: (paths: CliPlatformPaths) => Promise<StopResult>;
  readonly removeDir: (dir: string) => void;
  /** Starts the demo gateway; resolves true when it is up. */
  readonly start: () => Promise<boolean>;
  readonly seed: (paths: CliPlatformPaths) => Promise<DemoSeedSummary>;
  readonly runners: TourRunners;
  readonly locality: (paths: CliPlatformPaths) => Promise<LocalityReport>;
  readonly prove: (paths: CliPlatformPaths, since: number, until: number) => Promise<ProveResult>;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

const USAGE = "Usage: nimbus demo [--no-tour] | nimbus demo stop | nimbus demo reset";

export const defaultDemoDeps: DemoDeps = {
  paths: getCliPlatformPaths,
  stop: (p) => stopAndWaitForExit(p),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  start: async () => {
    const before = process.exitCode;
    await runStart(["--no-wizard"]);
    const ok = process.exitCode === undefined || process.exitCode === 0;
    if (ok) process.exitCode = before;
    return ok;
  },
  seed: (p) =>
    withGatewayIpc((c) => c.call<DemoSeedSummary>("demo.seed", {}), p, {
      requestTimeoutMs: BATCH_RPC_TIMEOUT_MS,
    }),
  // The SAME runner table `nimbus wow` uses, so a brief cannot behave differently on the two
  // surfaces — and the identity is pinned by a test, not just by both naming the same import.
  runners: defaultTourRunners,
  // `p` is threaded through rather than re-derived: the demo root is already resolved in
  // `runDemo`, and a second resolution here could reach a different (or the real) root.
  locality: (p) => withGatewayIpc((c) => c.call<LocalityReport>("locality.report", {}), p),
  prove: (p, since, until) =>
    withGatewayIpc((c) => c.call<ProveResult>("egress.proveWindow", { since, until }), p),
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
};

type DemoAction = "run" | "run-no-tour" | "stop" | "reset";

/**
 * Validates the WHOLE argv before anything is stopped, deleted or started: exactly `[]`,
 * `["--no-tour"]`, `["stop"]` or `["reset"]`. A surplus argument is refused rather than ignored —
 * `nimbus demo --no-tour stop` must not quietly recreate the root the user asked to stop.
 */
export function parseDemoArgs(args: readonly string[]): DemoAction {
  if (args.length === 0) return "run";
  if (args.length === 1) {
    if (args[0] === "--no-tour") return "run-no-tour";
    if (args[0] === "stop") return "stop";
    if (args[0] === "reset") return "reset";
  }
  throw new Error(`Unexpected arguments to nimbus demo: ${args.join(" ")}\n${USAGE}`);
}

/**
 * The recorded demo gateway is alive, was started in this boot, and does not answer on its socket
 * (`stopAndWaitForExit`'s `unresponsive` result). Nothing is deleted or started under a gateway
 * that may still hold the root open; the user ends the process themselves.
 */
export class DemoGatewayUnresponsiveError extends Error {
  constructor(pid: number) {
    super(
      `A demo gateway (pid ${String(pid)}) is running but not answering; end that process, then rerun \`nimbus demo\`.`,
    );
    this.name = "DemoGatewayUnresponsiveError";
  }
}

/** Stops the demo gateway, refusing to continue past one that is alive but unresponsive. */
async function stopOrAbort(
  deps: DemoDeps,
  paths: CliPlatformPaths,
): Promise<"stopped" | "not-running"> {
  const r = await deps.stop(paths);
  if (typeof r === "object") throw new DemoGatewayUnresponsiveError(r.pid);
  return r;
}

export async function runDemo(args: string[], deps: DemoDeps = defaultDemoDeps): Promise<void> {
  const action = parseDemoArgs(args);
  const paths = deps.paths();
  if (paths.demo !== true) {
    throw new Error("nimbus demo must resolve the demo root (internal error: NIMBUS_DEMO not set)");
  }
  const demoRoot = dirname(paths.dataDir);

  if (action === "stop") {
    const r = await stopOrAbort(deps, paths);
    deps.out(r === "stopped" ? "Demo gateway stopped.\n" : "No demo gateway was running.\n");
    return;
  }
  if (action === "reset") {
    await stopOrAbort(deps, paths);
    deps.removeDir(demoRoot);
    deps.out(`Demo root removed: ${demoRoot}\n`);
    return;
  }

  // Re-seed on every run by RECREATING the root (spec § 4.4) — the seeder never truncates.
  await stopOrAbort(deps, paths);
  deps.removeDir(demoRoot);
  if (!(await deps.start())) return; // runStart already printed why
  let seeded: DemoSeedSummary;
  try {
    seeded = await deps.seed(paths);
  } catch (err) {
    // Do not leave a gateway running over a half-seeded root. The seed failure is the error to
    // report, so a failure to stop is swallowed rather than allowed to replace it.
    await deps.stop(paths).catch(() => undefined);
    throw err;
  }
  deps.out(
    `Seeded the synthetic "Acme" org: ${String(seeded.counts.people)} people, ${String(seeded.counts.items)} items.\n`,
  );
  // Restart so every config read (me, roots, services) sees the seeded nimbus.toml.
  await stopOrAbort(deps, paths);
  if (!(await deps.start())) return;

  let failed = false;
  if (action === "run") {
    // The locality panel is one more step than the seeder planned, so the brief headers read
    // "[n/N+1]" rather than under-counting what actually prints. `runTour` renders every header
    // from this one total.
    const total = seeded.tour.length + 1;
    const results = await runTour(seeded.tour, deps.runners, deps.out, deps.err, total);
    // The window edges are the GATEWAY's own clock on both sides — `seeded.t0` (when seeding
    // finished) and the `t1` `locality.report` returns — never a `Date.now()` read here.
    const { proveFailed } = await printLocalityPanel(
      {
        locality: () => deps.locality(paths),
        prove: (since, until) => deps.prove(paths, since, until),
        out: deps.out,
      },
      seeded.t0,
      total,
    );
    failed = results.some((r) => !r.ok) || proveFailed;
  }
  deps.out(
    [
      "",
      "The demo gateway is still running on the synthetic org. Try:",
      "  nimbus --demo standup",
      "  nimbus --demo expert payments",
      "  nimbus --demo decisions",
      "  nimbus --demo stats deployment-frequency --service payment-service",
      "Stop it with `nimbus demo stop`; remove everything with `nimbus demo reset`.",
      "",
    ].join("\n"),
  );
  // Raised only AFTER the panel and the closing block have printed (mirrors `runWow`): a failed
  // step must not hide the honesty panel, and a failed `prove()` call still lets the panel and
  // the closing block print (see `printLocalityPanel`'s own doc comment) — in both of those cases
  // the output ends with the closing block whatever the exit code. The one case that is NOT true
  // of: a failing `locality()` call itself, which sits outside `printLocalityPanel`'s own `try`
  // and throws straight through this function before the closing block below ever prints — kept
  // that way deliberately for parity with `nimbus wow`.
  if (failed) throw new CliExit(1);
}
