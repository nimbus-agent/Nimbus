// packages/gateway/src/connectors/connector-writes/k8s-connector-handlers.test-helpers.ts
// TEST-ONLY. A child-process script for `k8s-connector.differential.test.ts`: it registers the
// INSTALLED `@nimbus-dev/connectors` kubernetes tools on a fake MCP server in the connector's
// `gateway` mode (raw handlers, the way the gateway runs them) and calls them with the cases it is
// given. It runs in its own process because the connector mode is locked per process and the
// handlers read `process.env`.
//
// Usage: `bun <this file>` with `K8S_PROBE_CASES` (a JSON array of `{tool, args}`); prints one JSON
// line per case: `{ok: true, text}` or `{ok: false, message}`.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@nimbus-dev/connectors/package.json"));

const { setConnectorMode } = (await import(join(root, "shared", "connector-mode.ts"))) as {
  setConnectorMode: (mode: "gateway" | "standalone") => void;
};
setConnectorMode("gateway");

const { registerKubernetesTools } = (await import(
  join(root, "connectors", "kubernetes", "src", "tools.ts")
)) as { registerKubernetesTools: (server: never) => void };

type Handler = (args: unknown) => Promise<{ content?: { text?: string }[] }>;
const handlers = new Map<string, Handler>();
const handle = { disable: () => undefined, enable: () => undefined, remove: () => undefined };
const fake = {
  server: { getClientCapabilities: () => undefined, oninitialized: undefined },
  registerTool: (name: string, _cfg: unknown, cb: Handler) => {
    handlers.set(name, cb);
    return handle;
  },
  tool: (name: string, ...rest: unknown[]) => {
    const cb = rest.at(-1) as Handler;
    handlers.set(name, cb);
    return handle;
  },
  sendToolListChanged: () => undefined,
  sendLoggingMessage: () => Promise.resolve(),
};
registerKubernetesTools(fake as never);

const cases = JSON.parse(process.env["K8S_PROBE_CASES"] ?? "[]") as {
  tool: string;
  args: unknown;
}[];
for (const c of cases) {
  const h = handlers.get(c.tool);
  if (h === undefined) {
    process.stdout.write(`${JSON.stringify({ ok: false, message: `no such tool ${c.tool}` })}
`);
    continue;
  }
  try {
    const out = await h(c.args);
    process.stdout.write(`${JSON.stringify({ ok: true, text: out.content?.[0]?.text ?? "" })}
`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e) })}
`);
  }
}
