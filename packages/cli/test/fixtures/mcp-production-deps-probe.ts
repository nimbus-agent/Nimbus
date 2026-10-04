/**
 * Child-process probe for `createProductionDeps` (`src/mcp/adapter.ts`), driven by
 * `src/mcp/adapter.coverage.test.ts`.
 *
 * It runs in a FRESH bun process because the production deps read `lib/gateway-process.ts` and
 * `ipc-client/index.ts`, and `test/helpers/cli-mocks.ts` replaces both with a process-global
 * `mock.module` for the rest of any combined `bun test` run — in-process, this would exercise the
 * fixture-driven fakes, not the production wiring. Here both are the real modules.
 *
 * argv: <root> <live socket path> <dead socket path>. The caller points this process's data
 * directory into <root> through the env it STARTS with (darwin's `homedir()` does not follow a
 * HOME changed later). Before touching anything, the probe REFUSES (exit 3) unless the gateway
 * state path it resolves lies inside <root>, so it can never read or overwrite a real install's
 * `gateway.json`. It also refuses unless `NIMBUS_GATEWAY_SOCKET` is set: the caller points it at
 * an endpoint nothing listens on, so the paths' DEFAULT socket — a live gateway's address — is
 * never the one in play. Prints one JSON report line on stdout.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

import { gatewayStatePath } from "../../src/lib/gateway-process.ts";
import { createProductionDeps } from "../../src/mcp/adapter.ts";
import { getCliPlatformPaths } from "../../src/paths.ts";

const [root = "", liveSocket = "", deadSocket = ""] = process.argv.slice(2);
if (root === "" || liveSocket === "" || deadSocket === "") {
  process.stderr.write("usage: mcp-production-deps-probe <root> <live socket> <dead socket>\n");
  process.exit(2);
}

const SOCKET_OVERRIDE = "NIMBUS_GATEWAY_SOCKET";
const sentinelSocket = process.env[SOCKET_OVERRIDE] ?? "";
if (sentinelSocket === "") {
  process.stderr.write(`refusing: ${SOCKET_OVERRIDE} must name an endpoint nothing listens on\n`);
  process.exit(3);
}

function isInside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The state path the production deps will read — or exit 3 when it lies outside `root`. */
function isolatedStatePath(): string {
  const statePath = gatewayStatePath(getCliPlatformPaths());
  if (!isInside(root, statePath) && !isInside(realpathSync(root), statePath)) {
    process.stderr.write(`refusing: gateway state path ${statePath} is outside ${root}\n`);
    process.exit(3);
  }
  return statePath;
}

function writeState(statePath: string, socketPath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ pid: process.pid, socketPath }), "utf8");
}

interface Failure {
  readonly name: string;
  readonly message: string;
}

/** How `getClient()` fails — or `null` when it unexpectedly connects. */
async function getClientFailure(): Promise<Failure | null> {
  try {
    const client = await createProductionDeps().getClient();
    await client.disconnect();
    return null;
  } catch (e) {
    return e instanceof Error
      ? { name: e.name, message: e.message }
      : { name: "non-Error", message: String(e) };
  }
}

// 1. No state file at all.
isolatedStatePath();
const noState = await getClientFailure();

// 2. The same, demo-rooted: a different state path, and a message naming the demo gateway. Demo
// mode refuses a relocated socket, so the sentinel is lifted for this scenario only — the demo
// socket's NAME is a hash of the demo root (inside <root>), so no other gateway listens there.
Reflect.deleteProperty(process.env, SOCKET_OVERRIDE);
process.env["NIMBUS_DEMO"] = "1";
isolatedStatePath();
const noStateDemo = await getClientFailure();
const demoFlag = createProductionDeps().demo === true;
Reflect.deleteProperty(process.env, "NIMBUS_DEMO");
process.env[SOCKET_OVERRIDE] = sentinelSocket;

// 3. A state file naming an endpoint nothing listens on.
const statePath = isolatedStatePath();
writeState(statePath, deadSocket);
const deadSocketFailure = await getClientFailure();

// 4. A state file naming the caller's live fake gateway.
writeState(statePath, liveSocket);
const deps = createProductionDeps();
const client = await deps.getClient();
const listed: unknown = await client.call("connector.listStatus");
const agentToolsDisabledReason = deps.agentToolsDisabledReason?.() ?? null;
await client.disconnect();

process.stdout.write(
  `${JSON.stringify({
    noState,
    noStateDemo,
    demoFlag,
    deadSocket: deadSocketFailure,
    live: { listed, agentToolsDisabledReason },
  })}\n`,
);
