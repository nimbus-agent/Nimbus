/**
 * Best-effort teardown for the in-tree HTTP test harnesses.
 *
 * Every harness (`agent-runs/agent-test-server.ts`, `briefs/brief-test-server.ts`,
 * `ipc/http-api-test-server.ts`) ends with the same `stop()`: shut the server,
 * close the database handle, remove the temp dir — each wrapped in its own
 * `try {} catch {}` so an earlier failure cannot strand the later steps. That
 * shape was written out four times; the property it encodes is easy to lose in
 * a re-indent, and losing it leaks a temp directory (and, on Windows, a locked
 * SQLite file) for every test file whose server failed to stop cleanly.
 *
 * `runQuietly` is that property, named once: EVERY step runs, in order,
 * whatever the ones before it threw.
 */
export function runQuietly(steps: ReadonlyArray<() => void>): void {
  for (const step of steps) {
    try {
      step();
    } catch {
      /* best-effort teardown: a failed step must not strand the ones after it */
    }
  }
}
