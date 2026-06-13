#!/usr/bin/env bun
// Portable wall-clock timeout for a child command, used by the cross-platform
// CI test step. GNU coreutils `timeout` is NOT installed on the GitHub macOS
// runner, so a shell `timeout` would break the macOS leg — Bun is guaranteed
// present (it is the test runner), so we wrap with Bun.spawn instead.
//
// On timeout we SIGTERM the child, escalate to SIGKILL after a grace period,
// and exit 124 (matching coreutils `timeout`) so the caller's retry loop treats
// it as a failure rather than a pass. This converts a hung `bun test` (which
// would otherwise burn the job's full `timeout-minutes` ceiling and surface as a
// confusing "The operation was canceled.") into a fast, clearly-labelled failure
// that retry-once can recover from when the hang is transient.
//
// Usage: bun scripts/run-with-timeout.ts <seconds> <command> [args...]

import process from "node:process";

const GRACE_MS = 10_000;
const EXIT_TIMEOUT = 124;
const EXIT_USAGE = 2;

const [secondsRaw, cmd, ...args] = process.argv.slice(2);
const seconds = Number(secondsRaw);

if (!Number.isFinite(seconds) || seconds <= 0 || cmd === undefined) {
  console.error("usage: run-with-timeout <seconds> <command> [args...]");
  process.exit(EXIT_USAGE);
}

const child = Bun.spawn([cmd, ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let timedOut = false;
const killTimer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  // If the child ignores SIGTERM, force-kill after a grace period.
  setTimeout(() => child.kill("SIGKILL"), GRACE_MS);
}, seconds * 1000);

const code = await child.exited;
clearTimeout(killTimer);

if (timedOut) {
  console.error(
    `\n[run-with-timeout] '${cmd}' exceeded ${seconds}s — killed (exit ${EXIT_TIMEOUT})`,
  );
  process.exit(EXIT_TIMEOUT);
}

process.exit(code);
