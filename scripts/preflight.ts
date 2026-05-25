#!/usr/bin/env bun
/**
 * Local CI-parity pre-flight. `bun run preflight` (full) / `bun run preflight:fast`.
 * Flags: --fast (fast tier only), --list (print gates, run nothing), --no-bail
 * (run all gates, don't stop at first failure).
 */
import { type Gate, type GateTier, selectGates } from "./lib/preflight-gates.ts";

const argv = Bun.argv.slice(2);
const fast = argv.includes("--fast");
const list = argv.includes("--list");
const noBail = argv.includes("--no-bail");
const tier: GateTier = fast ? "fast" : "full";
const gates = selectGates(tier);

if (list) {
  console.log(`preflight (${tier}) — ${gates.length} gates:`);
  for (const g of gates) console.log(`  - ${g.name}: ${g.cmd.join(" ")}${g.soft ? " (soft)" : ""}`);
  process.exit(0);
}

async function runGate(g: Gate): Promise<boolean> {
  const started = Date.now();
  process.stdout.write(`\n▶ ${g.name} …\n`);
  const proc = Bun.spawn(g.cmd as string[], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const code = await proc.exited;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = code === 0;
  process.stdout.write(`${ok ? "✓" : "✗"} ${g.name} (${secs}s)\n`);
  return ok || Boolean(g.soft);
}

const results: Array<{ gate: Gate; ok: boolean }> = [];
let hardFail = false;
for (const g of gates) {
  const ok = await runGate(g);
  results.push({ gate: g, ok });
  if (!ok) {
    hardFail = true;
    if (!noBail) break;
  }
}

// Output stays live (inherit) so long gates (build, test:ci) show progress.
// Rather than buffer failing stderr — which would hide that progress — re-print
// the exact command for each failed gate so the user can reproduce it in
// isolation without scrolling.
process.stdout.write(`\n── preflight (${tier}) summary ──\n`);
for (const r of results) process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${r.gate.name}\n`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  process.stdout.write("\nFailed gate(s) — re-run individually to see the failure:\n");
  for (const r of failed) process.stdout.write(`  ${r.gate.cmd.join(" ")}\n`);
}
process.stdout.write(hardFail ? "\npreflight FAILED\n" : "\npreflight PASSED\n");
process.exit(hardFail ? 1 : 0);
