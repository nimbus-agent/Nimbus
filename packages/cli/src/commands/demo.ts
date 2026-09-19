import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { stopAndWaitForExit } from "../lib/stop-and-wait.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";
import { runOncallCommand } from "./oncall.ts";
import { runOwnersCommand } from "./owners.ts";
import { runStart } from "./start.ts";
import { runWhyCli } from "./why.ts";

export interface DemoSeedSummary {
  readonly counts: { readonly people: number; readonly items: number };
  readonly tour: { readonly whyRef: string; readonly ownersPath: string };
}

export interface DemoDeps {
  readonly paths: () => CliPlatformPaths;
  readonly stop: (paths: CliPlatformPaths) => Promise<"stopped" | "not-running">;
  readonly removeDir: (dir: string) => void;
  /** Starts the demo gateway; resolves true when it is up. */
  readonly start: () => Promise<boolean>;
  readonly seed: (paths: CliPlatformPaths) => Promise<DemoSeedSummary>;
  readonly oncall: () => Promise<void>;
  readonly why: (ref: string) => Promise<void>;
  readonly owners: (dir: string) => Promise<void>;
  readonly out: (s: string) => void;
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
  oncall: () => runOncallCommand([]),
  why: (ref) => runWhyCli([ref]),
  owners: (dir) => runOwnersCommand([dir]),
  out: (s) => {
    process.stdout.write(s);
  },
};

function header(n: number, title: string, command: string): string {
  const lead = `── [${String(n)}/3] ${title} `;
  return `\n${lead.padEnd(56, "─")}\n$ ${command}\n`;
}

export async function runDemo(args: string[], deps: DemoDeps = defaultDemoDeps): Promise<void> {
  const paths = deps.paths();
  if (paths.demo !== true) {
    throw new Error("nimbus demo must resolve the demo root (internal error: NIMBUS_DEMO not set)");
  }
  const demoRoot = dirname(paths.dataDir);
  const sub = args[0];

  if (sub === "stop") {
    const r = await deps.stop(paths);
    deps.out(r === "stopped" ? "Demo gateway stopped.\n" : "No demo gateway was running.\n");
    return;
  }
  if (sub === "reset") {
    await deps.stop(paths);
    deps.removeDir(demoRoot);
    deps.out(`Demo root removed: ${demoRoot}\n`);
    return;
  }
  if (sub !== undefined && sub !== "--no-tour") {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  // Re-seed on every run by RECREATING the root (spec § 4.4) — the seeder never truncates.
  await deps.stop(paths);
  deps.removeDir(demoRoot);
  if (!(await deps.start())) return; // runStart already printed why
  const seeded = await deps.seed(paths);
  deps.out(
    `Seeded the synthetic "Acme" org: ${String(seeded.counts.people)} people, ${String(seeded.counts.items)} items.\n`,
  );
  // Restart so every config read (me, roots, services) sees the seeded nimbus.toml.
  await deps.stop(paths);
  if (!(await deps.start())) return;

  if (sub !== "--no-tour") {
    deps.out(header(1, "On-call triage", "nimbus --demo oncall"));
    await deps.oncall();
    deps.out(header(2, "Why this line changed", `nimbus --demo why ${seeded.tour.whyRef}`));
    await deps.why(seeded.tour.whyRef);
    deps.out(header(3, "Who owns this code", `nimbus --demo owners ${seeded.tour.ownersPath}`));
    await deps.owners(seeded.tour.ownersPath);
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
}
