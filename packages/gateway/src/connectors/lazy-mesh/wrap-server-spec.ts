/**
 * Wrap a `ServerSpec` so the MCPClient-spawned MCP child runs through
 * the platform sandbox runner (T2 PR 1, invariant `I15`).
 *
 * **Why this helper exists:**
 *
 * `@mastra/mcp@1.7.0`'s `MCPClient({ servers: { name: { command, args, env } } })`
 * builds each server from a `ServerSpec` triple and calls into
 * `StdioClientTransport`, which in turn forks the child via
 * `child_process.spawn`-equivalent machinery. There is no public hook
 * to intercept that fork. To route every MCP child through the
 * OS-native sandbox runner we rewrite the spec so MCPClient launches
 * `sandbox-wrapper.ts` (under `process.execPath` — the Bun binary), and
 * the wrapper in turn invokes the platform sandbox runner's `spawn`
 * method on the caller-supplied command + args with
 * `stdio: "inherit"` so the MCP JSON-RPC frames pass through
 * transparently.
 *
 * **Env contract (consumed and stripped by the wrapper):**
 *
 * - `NIMBUS_SANDBOX_MANIFEST_JSON` — JSON-stringified `ExtensionManifest`.
 * - `NIMBUS_SANDBOX_CWD` — working directory for the sandboxed child.
 *
 * Both are deleted from the child's `process.env` inside the wrapper so a
 * sandboxed connector that re-execs cannot re-enter the wrapper (the
 * wrapper would `fatal()` on a missing `NIMBUS_SANDBOX_MANIFEST_JSON`
 * anyway, but the explicit strip closes the double-wrap path).
 *
 * **Invariant `I15` enforcement target:**
 *
 * Every `ServerSpec` constructed under `connectors/lazy-mesh/` must be
 * wrapped via `wrapServerSpec(...)` before it reaches `new MCPClient(...)`.
 * The T2 PR 1 enforcement test (`security-invariants.test.ts`) and the
 * D10 static rule (`check-nimbus-invariants.ts`) both grep for
 * `wrapServerSpec(` in the four lazy-mesh files.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { ServerSpec } from "./slot.ts";

/**
 * Absolute path to `sandbox-wrapper.ts`. Resolved at module load so it
 * stays correct under bundlers and `node_modules` packaging without
 * needing a `__dirname` shim.
 */
const WRAPPER_PATH = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "platform",
  "sandbox",
  "sandbox-wrapper.ts",
);

/**
 * Rewrite a `ServerSpec` so MCPClient spawns `sandbox-wrapper.ts` with
 * the original command + args appended, and the wrapper-control env vars
 * (manifest, cwd) layered on top of the caller-supplied env.
 *
 * @param spec     Original ServerSpec (typically built with
 *                 `command`, `args`, `env: extensionProcessEnv({...})`).
 * @param manifest Resolved extension manifest. For first-party connectors
 *                 callers pass `manifestForFirstParty(serviceId)`. For
 *                 user MCPs the registry-stored manifest is used (Task 15
 *                 hard-disables user MCPs that lack one).
 * @param cwd      Working directory of the sandboxed child. The sandbox
 *                 always grants read/write to this path.
 */
export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
  return {
    command: process.execPath,
    args: [WRAPPER_PATH, spec.command, ...spec.args],
    env: {
      ...spec.env,
      NIMBUS_SANDBOX_MANIFEST_JSON: JSON.stringify(manifest),
      NIMBUS_SANDBOX_CWD: cwd,
    },
  };
}

/**
 * Exported for the I15 enforcement test — the wrapper path must resolve
 * to a file under `platform/sandbox/`. Tests inspect this constant
 * rather than reaching into module internals.
 */
export const SANDBOX_WRAPPER_PATH = WRAPPER_PATH;
