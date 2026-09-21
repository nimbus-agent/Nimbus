/**
 * Best-effort IPC teardown for a `finally` block.
 *
 * A throw from a `finally` REPLACES whatever was already propagating. Since the agent-brief
 * commands throw `CliExit` instead of calling `process.exit`, their cleanup now runs on the failure
 * path too — so a rejecting `disconnect()` would swallow the `CliExit`, and `main()` would print
 * the teardown error and exit 1 instead of the code the command asked for. The command's outcome is
 * already decided by the time this runs; a failed teardown of a socket the process is about to drop
 * anyway must not change it.
 */
export async function disconnectQuietly(client: {
  disconnect: () => Promise<void> | void;
}): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // Deliberately ignored — see above.
  }
}
