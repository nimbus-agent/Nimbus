#!/usr/bin/env bun
import { runStandalone } from "./launcher.ts";

/**
 * The `nimbus-mcp` process entry point, and nothing else.
 *
 * Split from `launcher.ts` so that file stays pure, fully testable logic. An `import.meta.main`
 * block cannot be exercised in-process by any test, so leaving it inside the launcher would have
 * meant either an uncoverable branch or exempting the eligibility logic from coverage with it —
 * and the eligibility logic is the part worth covering.
 */
const code = await runStandalone(process.argv.slice(2));
// Exit ONLY on failure. Most connectors connect their stdio transport at module scope, so the
// import inside runStandalone resolves once the server is live and it returns 0 immediately —
// `process.exit(0)` here would tear down the server it just started. On success we fall through
// and the connected transport keeps the process alive.
if (code !== 0) {
  process.exit(code);
}
