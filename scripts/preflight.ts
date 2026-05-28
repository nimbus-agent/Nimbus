#!/usr/bin/env bun
import { type Gate, type GateTier, selectGates } from "./lib/preflight-gates.ts";

async function runGate(g: Gate): Promise<boolean> {
  const started = Date.now();
  process.stdout.write(`\n▶ ${g.name} …\n`);
  const proc = Bun.spawn([...g.cmd], {
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

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const fast = argv.includes("--fast");
  const list = argv.includes("--list");
  const noBail = argv.includes("--no-bail");
  const tier: GateTier = fast ? "fast" : "full";
  const gates = selectGates(tier);

  if (list) {
    console.log(`preflight (${tier}) — ${gates.length} gates:`);
    for (const g of gates) {
      console.log(`  - ${g.name}: ${g.cmd.join(" ")}${g.soft ? " (soft)" : ""}`);
    }
    return;
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

  process.stdout.write(`\n── preflight (${tier}) summary ──\n`);
  for (const r of results) process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${r.gate.name}\n`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.stdout.write("\nFailed gate(s) — re-run individually to see the failure:\n");
    for (const r of failed) process.stdout.write(`  ${r.gate.cmd.join(" ")}\n`);
  }
  process.stdout.write(hardFail ? "\npreflight FAILED\n" : "\npreflight PASSED\n");
  process.exit(hardFail ? 1 : 0);
}

if (import.meta.main) await main();
