/**
 * listFirstPartyServerTools: one first-party server's raw tools. Every guard is tested against the
 * ensure seam: a refused service must never reach `ensurePhase3BundleRunning`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot } from "./slot.ts";

const roots: string[] = [];
let mesh: LazyConnectorMesh | undefined;

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-fp-"));
  roots.push(root);
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
  };
}

afterEach(async () => {
  if (mesh !== undefined) await mesh.disconnect();
  mesh = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SCHEMA = { type: "object", properties: { name: { type: "string" } } };

function bundleWith(m: LazyConnectorMesh, tools: Record<string, unknown>): void {
  const client = { listTools: () => Promise.resolve(tools), disconnect: () => Promise.resolve() };
  (m as unknown as { lazySlots: Map<string, LazyMcpSlot> }).lazySlots.set(LAZY_MESH.phase3Bundle, {
    client: client as unknown as MCPClient,
    idleTimer: undefined,
    drain: new LazyDrainTracker(),
  });
}

async function build(opts: {
  allowed?: (s: string) => boolean;
  secrets?: Record<string, string>;
  tools?: Record<string, unknown>;
}) {
  const vault = createMockVault();
  for (const [k, v] of Object.entries(opts.secrets ?? {})) await vault.set(k, v);
  const m = new LazyConnectorMesh(makePaths(), vault, {
    ...(opts.allowed === undefined ? {} : { isConnectorAllowed: opts.allowed }),
  });
  mesh = m;
  let ensures = 0;
  m.ensurePhase3BundleRunning = async () => {
    ensures += 1;
  };
  if (opts.tools !== undefined) bundleWith(m, opts.tools);
  return { m, ensures: () => ensures };
}

const ARGO = { "argocd.url": "https://argo.example.com", "argocd.token": "t" };
const ARGO_TOOLS = {
  argocd_app_sync: { description: "sync", inputSchema: SCHEMA, execute: async () => ({}) },
  flux_reconcile: { description: "foreign", execute: async () => ({}) },
};

describe("listFirstPartyServerTools", () => {
  test("a configured, allowed service lists its raw entries (inputSchema kept), foreign keys filtered", async () => {
    const { m, ensures } = await build({ secrets: ARGO, tools: ARGO_TOOLS });
    const out = await m.listFirstPartyServerTools("argocd");
    expect(Object.keys(out ?? {})).toEqual(["argocd_app_sync"]);
    const entry = out?.["argocd_app_sync"] as { inputSchema: unknown } | undefined;
    expect(entry?.inputSchema).toEqual(SCHEMA);
    expect(ensures()).toBe(1);
  });

  test("a policy-blocked service whose credentials ARE present spawns nothing", async () => {
    const asked: string[] = [];
    const { m, ensures } = await build({
      secrets: ARGO,
      tools: ARGO_TOOLS,
      allowed: (s) => {
        asked.push(s);
        return false;
      },
    });
    expect(await m.listFirstPartyServerTools("argocd")).toBeUndefined();
    expect(asked).toEqual(["argocd"]);
    expect(ensures()).toBe(0);
  });

  test("an unconfigured service inside an already-running bundle returns undefined", async () => {
    // flux has no credentials; the bundle is up (for argocd) and lists flux tools.
    const { m, ensures } = await build({ secrets: ARGO, tools: ARGO_TOOLS });
    expect(await m.listFirstPartyServerTools("flux")).toBeUndefined();
    expect(ensures()).toBe(0);
  });

  test("a service with write rows but no map entry fails closed", async () => {
    const { m, ensures } = await build({
      secrets: { "slack.token": "x" },
      tools: { slack_x: {} },
    });
    expect(await m.listFirstPartyServerTools("slack")).toBeUndefined();
    expect(ensures()).toBe(0);
  });

  test("a service without write rows, and user-MCP / extension ids, return undefined", async () => {
    const { m, ensures } = await build({ secrets: ARGO, tools: ARGO_TOOLS });
    for (const s of ["datadog", "mcp_demo", "ext_demo", "", "__proto__", "constructor"]) {
      expect(await m.listFirstPartyServerTools(s), s).toBeUndefined();
    }
    expect(ensures()).toBe(0);
  });
});
