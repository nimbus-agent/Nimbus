# True Coverage D1 — Gateway I/O-shell un-excludes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un-exclude 3 gateway I/O shells from `scripts/coverage-floor/exclusions.ts` by extracting their testable logic behind clean seams, so each rejoins the ≥80% line+branch floor.

**Architecture:** Honest-shrink (spec §1). For each file, add a minimal seam (a structural-interface factory, or an *extract-to-exported-helper* — never an inject-with-default-param, which leaves the default-evaluation branch uncovered and would run a real subprocess). Test the extracted logic directly with fakes; the irreducible real-construction line (1–3 lines, no branches) stays in the thin public fn, and the file still clears the floor. Then drop the exclusion (and the one Sonar `coverage.exclusions` entry). Coverage is verified CI-Linux-authoritatively via a Docker dry-run + reseed-from-PR-merge-lcov.

**Tech stack:** Bun 1.2+ / TypeScript 6 strict, `bun:test`, Biome, istanbul-instrumented coverage-floor gate.

**Scope (3 files, confirmed on read 2026-06-13):**

- `packages/gateway/src/federation/mdns-discovery-provider.ts` — bonjour factory seam (new test).
- `packages/gateway/src/teamvault/team-tool-spawn.ts` — extract `runSpawnedToolCall` + export `spawnerFor` (new test). ⚠️ I19/D15.
- `packages/gateway/src/chatops/chatops-bot-spawn-call.ts` — extract `runBotToolCall` (extend existing test). ⚠️ I15/I23.

**Out of scope (demoted on read — see spec §3(a)):** `gateway-process.ts` (mock.module-shadowed twin), `sandbox-wrapper.ts` (process entry), `client/stream-events.ts` (type-only). These move to D3's documentation pass, not here.

**Non-negotiables (every task):** No `any` (use `unknown`/structural interfaces). No `mock.module` (DI/fakes only). No `biome-ignore`/`istanbul-ignore`. DI seams are zero-behavior-change: the existing public function signatures stay identical; we only ADD exports. Run `bunx biome check <changed files>` (not `bun run lint`, which false-passes in a `.claude/worktree`).

---

## Task 1: `mdns-discovery-provider.ts` — bonjour factory seam + tests + un-exclude

**Files:**

- Modify: `packages/gateway/src/federation/mdns-discovery-provider.ts`
- Create: `packages/gateway/src/federation/mdns-discovery-provider.test.ts`
- Modify: `scripts/coverage-floor/exclusions.ts` (drop the entry)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/federation/mdns-discovery-provider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { DiscoveredPeer } from "./discovery.ts";
import {
  type BonjourLike,
  type BonjourServiceLike,
  MdnsDiscoveryProvider,
} from "./mdns-discovery-provider.ts";

/** A broadcast-free fake bonjour: captures the `find` callback so a test can drive
 *  discovered-service events synchronously, and records publish/destroy/stop. */
function makeFakeBonjour() {
  let onUp: ((s: BonjourServiceLike) => void) | undefined;
  const published: Array<{ name: string; type: string; port: number }> = [];
  const state = { destroyed: false, browserStopped: false };
  const bonjour: BonjourLike = {
    find: (_opts, cb) => {
      onUp = cb;
      return {
        stop: () => {
          state.browserStopped = true;
        },
      };
    },
    publish: (o) => {
      published.push(o);
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return {
    bonjour,
    emit: (s: BonjourServiceLike) => onUp?.(s),
    published,
    state,
  };
}

describe("MdnsDiscoveryProvider", () => {
  test("default constructor (no factory) — list is empty before start, no socket opened", async () => {
    // Exercises the default-param binding WITHOUT calling start() (so no real bonjour socket).
    const provider = new MdnsDiscoveryProvider();
    expect(await provider.list()).toEqual([]);
  });

  test("start() records a service whose host comes from addresses[0]", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-a", addresses: ["10.0.0.5"], host: "ignored.local", port: 8080 });
    expect(await provider.list()).toEqual([
      { instanceName: "peer-a", host: "10.0.0.5", port: 8080 },
    ]);
  });

  test("start() falls back to service.host when addresses is empty/undefined", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-b", host: "peer-b.local", port: 9090 });
    expect(await provider.list()).toEqual([
      { instanceName: "peer-b", host: "peer-b.local", port: 9090 },
    ]);
  });

  test("start() ignores a service with no usable host", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-c", port: 1234 }); // no addresses, no host
    expect(await provider.list()).toEqual([]);
  });

  test("start() ignores a service with a non-numeric port", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-d", host: "peer-d.local" }); // port undefined
    expect(await provider.list()).toEqual([]);
  });

  test("list() merges discovered + manual peers", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    fake.emit({ name: "peer-e", host: "e.local", port: 1 });
    const manual: DiscoveredPeer = { instanceName: "manual-x", host: "x.local", port: 2 };
    provider.addManualPeer(manual);
    expect(await provider.list()).toEqual([
      { instanceName: "peer-e", host: "e.local", port: 1 },
      manual,
    ]);
  });

  test("advertise() before start is a no-op; after start it publishes", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.advertise("early", 1); // bonjour undefined → no-op (optional-chain false arm)
    expect(fake.published).toEqual([]);
    await provider.start();
    await provider.advertise("me", 7070);
    expect(fake.published).toEqual([{ name: "me", type: "nimbus", port: 7070 }]);
  });

  test("stop() stops the browser, destroys bonjour, and resets (idempotent)", async () => {
    const fake = makeFakeBonjour();
    const provider = new MdnsDiscoveryProvider(() => fake.bonjour);
    await provider.start();
    await provider.stop();
    expect(fake.state.browserStopped).toBe(true);
    expect(fake.state.destroyed).toBe(true);
    await provider.stop(); // second stop: both undefined → optional-chain false arms, no throw
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test src/federation/mdns-discovery-provider.test.ts`
Expected: FAIL — `BonjourLike`/`BonjourServiceLike` not exported, `MdnsDiscoveryProvider` constructor takes no factory arg.

- [ ] **Step 3: Refactor the source behind a structural-interface seam**

Replace the entire contents of `packages/gateway/src/federation/mdns-discovery-provider.ts` with:

```ts
import BonjourLib from "bonjour-service";
import type { DiscoveredPeer, DiscoveryProvider } from "./discovery.ts";

const SERVICE_TYPE = "nimbus"; // bonjour-service advertises this as _nimbus._tcp

/** Structural seam types (avoid `any` and the `InstanceType<typeof BonjourLib>` import in tests). */
export interface BonjourServiceLike {
  readonly name: string;
  readonly host?: string;
  readonly port?: number;
  readonly addresses?: readonly string[];
}
export interface BonjourBrowserLike {
  stop(): void;
}
export interface BonjourLike {
  find(opts: { type: string }, onUp: (service: BonjourServiceLike) => void): BonjourBrowserLike;
  publish(opts: { name: string; type: string; port: number }): void;
  destroy(): void;
}
export type BonjourFactory = () => BonjourLike;

// The real bonjour-service instance structurally satisfies BonjourLike; the `as unknown as`
// bridges the wider real type to the seam interface used for testability.
const defaultBonjourFactory: BonjourFactory = () => new BonjourLib() as unknown as BonjourLike;

// MdnsDiscoveryProvider is a thin bonjour-service socket shell (advertise/browse _nimbus._tcp).
// Real multicast cannot run on CI, so the bonjour client is injected via a factory (default = the
// real library) and the discovery logic (host-extraction, manual merge, lifecycle) is unit-tested
// against a broadcast-free fake. The DiscoveryProvider interface + InMemoryDiscoveryProvider live
// in discovery.ts.
export class MdnsDiscoveryProvider implements DiscoveryProvider {
  private bonjour: BonjourLike | undefined;
  private browser: BonjourBrowserLike | undefined;
  private readonly seen = new Map<string, DiscoveredPeer>();
  private readonly manual: DiscoveredPeer[] = [];
  private readonly makeBonjour: BonjourFactory;

  constructor(makeBonjour: BonjourFactory = defaultBonjourFactory) {
    this.makeBonjour = makeBonjour;
  }

  async start(): Promise<void> {
    this.bonjour = this.makeBonjour();
    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (service) => {
      const host = service.addresses?.[0] ?? service.host;
      if (typeof host === "string" && typeof service.port === "number") {
        this.seen.set(service.name, {
          instanceName: service.name,
          host,
          port: service.port,
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.browser?.stop();
    this.bonjour?.destroy();
    this.browser = undefined;
    this.bonjour = undefined;
  }

  async list(): Promise<readonly DiscoveredPeer[]> {
    return [...this.seen.values(), ...this.manual];
  }

  async advertise(instanceName: string, port: number): Promise<void> {
    this.bonjour?.publish({ name: instanceName, type: SERVICE_TYPE, port });
  }

  addManualPeer(peer: DiscoveredPeer): void {
    this.manual.push(peer);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/gateway && bun test src/federation/mdns-discovery-provider.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Drop the exclusion**

In `scripts/coverage-floor/exclusions.ts`, delete these lines (the comment block + the entry):

```ts
  // MdnsDiscoveryProvider is a thin bonjour-service socket shell (advertise/browse
  // _nimbus._tcp) with no injection seam — real multicast can't run on CI, so it's
  // exercised only by the skippable Task 15 mDNS E2E. The testable discovery logic
  // (DiscoveryProvider interface + InMemoryDiscoveryProvider) lives in discovery.ts,
  // which IS covered.
  { kind: "exact", path: "packages/gateway/src/federation/mdns-discovery-provider.ts" },
```

- [ ] **Step 6: Typecheck + lint the changed files**

Run: `cd packages/gateway && bunx tsc --noEmit` then from repo root `bunx biome check packages/gateway/src/federation/mdns-discovery-provider.ts packages/gateway/src/federation/mdns-discovery-provider.test.ts scripts/coverage-floor/exclusions.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/federation/mdns-discovery-provider.ts \
        packages/gateway/src/federation/mdns-discovery-provider.test.ts \
        scripts/coverage-floor/exclusions.ts
git commit -m "test(coverage-D1): un-exclude mdns-discovery-provider via bonjour factory seam"
```

---

## Task 2: `team-tool-spawn.ts` — extract `runSpawnedToolCall` + export `spawnerFor` + tests + un-exclude

**Files:**

- Modify: `packages/gateway/src/teamvault/team-tool-spawn.ts`
- Create: `packages/gateway/src/teamvault/team-tool-spawn.test.ts`
- Modify: `scripts/coverage-floor/exclusions.ts` (drop the entry)
- Modify: `sonar-project.properties` (drop the `team-tool-spawn.ts` coverage-exclusion entry)

⚠️ **I19/D15:** This task ADDs exports (`spawnerFor`, `runSpawnedToolCall`) and makes **one tested, strictly-safer error-path change** (moving `await spawner(ctx)` inside the try so a partially-registered client is cleaned up if the spawner throws — Antigravity review 2.1). The public `spawnTeamToolAndCall(req)` signature is unchanged, and **the I19 secret path is untouched**: the seam selects *which* spawner; secrets still flow only through the real spawner's subprocess env (I1 `extensionProcessEnv` + I15 `wrapServerSpec`). The I19 runtime test injects at the `invoke-gate.ts`/`team-tool-invoke.ts` layer (not `spawnTeamToolAndCall`), so it is unaffected — Task 4 re-verifies.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/teamvault/team-tool-spawn.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { MCPClient } from "@mastra/mcp";

import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { runSpawnedToolCall, spawnerFor } from "./team-tool-spawn.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";

const fakeVault: NimbusVault = {
  get: () => Promise.resolve(null),
  set: () => Promise.reject(new Error("read-only")),
  delete: () => Promise.reject(new Error("read-only")),
  listKeys: () => Promise.resolve([]),
};

function req(over: Partial<TeamToolSpawnRequest> = {}): TeamToolSpawnRequest {
  return { service: "github", toolId: "list_issues", args: { a: 1 }, vaultView: fakeVault, sandboxCwd: "/cwd", ...over };
}

/** A fake MCPClient exposing only the surface runSpawnedToolCall touches: listTools + disconnect. */
function fakeClient(
  tools: LazyMeshToolMap,
  onDisconnect: () => Promise<void> = () => Promise.resolve(),
): MCPClient {
  return { listTools: () => Promise.resolve(tools), disconnect: onDisconnect } as unknown as MCPClient;
}

/** A fake spawner that populates the ctx clients map (mirrors what a real spawner does). */
function spawnerWith(...clients: ReadonlyArray<readonly [string, MCPClient]>) {
  return async (ctx: MeshSpawnContext): Promise<void> => {
    for (const [key, client] of clients) ctx.setLazyClient(key, client);
  };
}

describe("spawnerFor", () => {
  test("returns the single-service spawner for a known service", () => {
    expect(spawnerFor("github")).toBe(spawners.ensureGithubMcp);
    expect(spawnerFor("slack")).toBe(spawners.ensureSlackMcp);
  });

  test("falls back to the phase-3 bundle spawner for any other service", () => {
    expect(spawnerFor("aws")).toBe(spawners.ensurePhase3BundleMcp);
    expect(spawnerFor("totally-unknown")).toBe(spawners.ensurePhase3BundleMcp);
  });
});

describe("runSpawnedToolCall", () => {
  test("calls the requested tool and returns its result", async () => {
    const client = fakeClient({ list_issues: { execute: (a) => Promise.resolve({ got: a }) } });
    const result = await runSpawnedToolCall(spawnerWith(["github", client]), req());
    expect(result).toEqual({ got: { a: 1 } });
  });

  test("searches across multiple clients and returns from the one that has the tool", async () => {
    const noMatch = fakeClient({ other_tool: { execute: () => Promise.resolve("nope") } });
    const match = fakeClient({ list_issues: { execute: () => Promise.resolve("yes") } });
    const result = await runSpawnedToolCall(spawnerWith(["a", noMatch], ["b", match]), req());
    expect(result).toBe("yes");
  });

  test("skips a tool whose execute is undefined and throws not-found", async () => {
    const client = fakeClient({ list_issues: {} }); // present but no execute
    await expect(runSpawnedToolCall(spawnerWith(["github", client]), req())).rejects.toThrow(
      /tool "list_issues" not found for service "github"/,
    );
  });

  test("throws not-found when no client exposes the tool", async () => {
    const client = fakeClient({ unrelated: { execute: () => Promise.resolve(1) } });
    await expect(runSpawnedToolCall(spawnerWith(["github", client]), req())).rejects.toThrow(
      /not found for service "github"/,
    );
  });

  test("disconnects every client in finally, swallowing disconnect errors", async () => {
    let disconnected = 0;
    const client = fakeClient(
      { list_issues: { execute: () => Promise.resolve("ok") } },
      () => {
        disconnected += 1;
        return Promise.reject(new Error("disconnect boom"));
      },
    );
    const result = await runSpawnedToolCall(spawnerWith(["github", client]), req());
    expect(result).toBe("ok");
    expect(disconnected).toBe(1); // rejection swallowed, no throw
  });

  test("disconnects partially-registered clients if the spawner throws mid-registration", async () => {
    let disconnected = 0;
    const partial = fakeClient({}, () => {
      disconnected += 1;
      return Promise.resolve();
    });
    const spawner = async (ctx: MeshSpawnContext): Promise<void> => {
      ctx.setLazyClient("partial", partial);
      throw new Error("spawn boom");
    };
    // The spawner error propagates, but the already-registered client is still disconnected.
    await expect(runSpawnedToolCall(spawner, req())).rejects.toThrow("spawn boom");
    expect(disconnected).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test src/teamvault/team-tool-spawn.test.ts`
Expected: FAIL — `runSpawnedToolCall` / `spawnerFor` not exported.

- [ ] **Step 3: Refactor the source (extract + export; public fn unchanged)**

In `packages/gateway/src/teamvault/team-tool-spawn.ts`, change `spawnerFor` to `export`, extract the lifecycle into an exported `runSpawnedToolCall`, and reduce `spawnTeamToolAndCall` to the thin composition. Replace the `spawnerFor` function and `spawnTeamToolAndCall` function (lines 38–78) with:

```ts
export function spawnerFor(service: string): Spawner {
  // Phase-3 cloud/observability/data connectors (aws, azure, gcp, grafana, sentry, datadog, …)
  // are all started by the bundle spawner, which only launches the credentialed server.
  return SINGLE_SERVICE_SPAWNERS[service] ?? spawners.ensurePhase3BundleMcp;
}

/**
 * The testable lifecycle of {@link spawnTeamToolAndCall}: run `spawner` (which populates the
 * clients map), call the named tool on whichever spawned client exposes it, and disconnect all.
 * Extracted so the spawn-call-drain logic is unit-testable with a fake spawner + fake clients,
 * without opening a real connector subprocess. `spawner(ctx)` runs INSIDE the try so a
 * partially-registered client is still disconnected if the spawner throws mid-registration.
 */
export async function runSpawnedToolCall(
  spawner: Spawner,
  req: TeamToolSpawnRequest,
): Promise<unknown> {
  const clients = new Map<string, MCPClient>();
  const ctx: MeshSpawnContext = {
    vault: req.vaultView,
    sandboxCwd: req.sandboxCwd,
    clearLazyIdle: () => {},
    getLazyClient: (key) => clients.get(key),
    setLazyClient: (key, client) => {
      clients.set(key, client);
    },
    bumpToolsEpoch: () => {},
    scheduleLazyDisconnect: () => {},
  };

  try {
    await spawner(ctx);
    for (const client of clients.values()) {
      const tools = await listLazyMeshClientTools(client);
      const tool = tools[req.toolId];
      if (tool?.execute !== undefined) {
        return await tool.execute(req.args);
      }
    }
    throw new Error(`team-vault: tool "${req.toolId}" not found for service "${req.service}"`);
  } finally {
    for (const client of clients.values()) {
      await client.disconnect().catch(() => {});
    }
  }
}

/**
 * The real ephemeral-spawn seam for {@link invokeTeamTool}. Spawns a throwaway connector instance
 * fed by the team-scoped vault view, calls the named tool, and tears the instance down. The team
 * secret only ever lives in the spawned subprocess env + the view's call scope — never returned.
 */
export async function spawnTeamToolAndCall(req: TeamToolSpawnRequest): Promise<unknown> {
  return runSpawnedToolCall(spawnerFor(req.service), req);
}
```

(The `Spawner` type, `SINGLE_SERVICE_SPAWNERS` map, and all imports stay as-is.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/gateway && bun test src/teamvault/team-tool-spawn.test.ts`
Expected: PASS (8 tests: 2 `spawnerFor` + 6 `runSpawnedToolCall`).

- [ ] **Step 5: Drop the gate exclusion + the Sonar coverage-exclusion**

In `scripts/coverage-floor/exclusions.ts`, delete the comment block + entry:

```ts
  // Team-vault ephemeral connector spawn: real MCPClient subprocess lifecycle (I/O glue, reuses the
  // existing per-service spawners). Exercised end-to-end by the two-gateway invoke integration test.
  { kind: "exact", path: "packages/gateway/src/teamvault/team-tool-spawn.ts" },
```

In `sonar-project.properties` line 74 (`sonar.coverage.exclusions=`), remove the `,packages/gateway/src/teamvault/team-tool-spawn.ts` token (it is the last entry — delete the leading comma + the path so the list stays comma-separated with no trailing comma).

- [ ] **Step 6: Typecheck + lint the changed files**

Run: `cd packages/gateway && bunx tsc --noEmit` then from repo root `bunx biome check packages/gateway/src/teamvault/team-tool-spawn.ts packages/gateway/src/teamvault/team-tool-spawn.test.ts scripts/coverage-floor/exclusions.ts`
Expected: no errors. (Biome does not lint `.properties`.)

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/teamvault/team-tool-spawn.ts \
        packages/gateway/src/teamvault/team-tool-spawn.test.ts \
        scripts/coverage-floor/exclusions.ts sonar-project.properties
git commit -m "test(coverage-D1): un-exclude team-tool-spawn via runSpawnedToolCall extract (I19-safe)"
```

---

## Task 3: `chatops-bot-spawn-call.ts` — extract `runBotToolCall` + extend tests + un-exclude

**Files:**

- Modify: `packages/gateway/src/chatops/chatops-bot-spawn-call.ts`
- Modify: `packages/gateway/src/chatops/chatops-bot-spawn-call.test.ts` (extend; keep the 4 existing fail-closed tests)
- Modify: `scripts/coverage-floor/exclusions.ts` (drop the entry)

⚠️ **I15/I23:** Only ADDs an exported helper; reuses the already-covered sandbox-wrapped builders (`chatopsSlackBotServers`/`chatopsTeamsBotServers`), authors no `ServerSpec`.

- [ ] **Step 1: Write the failing test (extend the existing file)**

In `packages/gateway/src/chatops/chatops-bot-spawn-call.test.ts`: add the three new imports below
**with the existing imports at the top of the file** (`MCPClient` type, `LazyMeshToolMap` type,
`runBotToolCall`), then add the new `describe` block at the **bottom**. Keep the existing imports +
4 fail-closed tests unchanged. (`describe`/`expect`/`test` are already imported on line 1.)

```ts
import type { MCPClient } from "@mastra/mcp";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import { runBotToolCall } from "./chatops-bot-spawn-call.ts";

function fakeClient(
  tools: LazyMeshToolMap,
  onDisconnect: () => Promise<void> = () => Promise.resolve(),
): MCPClient {
  return { listTools: () => Promise.resolve(tools), disconnect: onDisconnect } as unknown as MCPClient;
}

describe("runBotToolCall — post-spawn tool dispatch (fake client, no subprocess)", () => {
  test("calls the tool by its exact id and returns the result", async () => {
    const client = fakeClient({ slack_chat_post: { execute: (a) => Promise.resolve({ posted: a }) } });
    expect(await runBotToolCall(client, "slack", "slack_chat_post", { text: "hi" })).toEqual({
      posted: { text: "hi" },
    });
  });

  test("falls back to the platform-prefixed tool id", async () => {
    const client = fakeClient({ slack_chat_post: { execute: () => Promise.resolve("ok") } });
    // caller passes the bare id; lookup falls back to `${platform}_${toolId}`
    expect(await runBotToolCall(client, "slack", "chat_post", {})).toBe("ok");
  });

  test("throws not-found when neither the id nor the prefixed id resolves to an executable tool", async () => {
    const client = fakeClient({ unrelated: { execute: () => Promise.resolve(1) } });
    await expect(runBotToolCall(client, "teams", "teams_chat_post", {})).rejects.toThrow(
      /tool "teams_chat_post" not found for platform "teams"/,
    );
  });

  test("throws not-found when the matched tool has no execute", async () => {
    const client = fakeClient({ slack_chat_post: {} });
    await expect(runBotToolCall(client, "slack", "slack_chat_post", {})).rejects.toThrow(/not found/);
  });

  test("disconnects in finally, swallowing disconnect errors", async () => {
    let disconnected = 0;
    const client = fakeClient({ slack_chat_post: { execute: () => Promise.resolve("done") } }, () => {
      disconnected += 1;
      return Promise.reject(new Error("disconnect boom"));
    });
    expect(await runBotToolCall(client, "slack", "slack_chat_post", {})).toBe("done");
    expect(disconnected).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test src/chatops/chatops-bot-spawn-call.test.ts`
Expected: FAIL — `runBotToolCall` not exported.

- [ ] **Step 3: Refactor the source (extract the dispatch; public fn unchanged)**

In `packages/gateway/src/chatops/chatops-bot-spawn-call.ts`, replace the body of `spawnChatopsBotToolAndCall` (lines 36–55) with an extracted exported `runBotToolCall` + the thin public fn:

```ts
/**
 * The testable post-spawn dispatch of {@link spawnChatopsBotToolAndCall}: look up the tool (by id,
 * then platform-prefixed id), execute it, and disconnect in `finally`. Extracted so the dispatch
 * logic is unit-testable with a fake MCPClient, without opening a real bot connector subprocess.
 */
export async function runBotToolCall(
  client: MCPClient,
  platform: "slack" | "teams",
  toolId: string,
  args: unknown,
): Promise<unknown> {
  try {
    const tools = await listLazyMeshClientTools(client);
    const tool = tools[toolId] ?? tools[`${platform}_${toolId}`];
    if (tool?.execute === undefined) {
      throw new Error(`chatops: tool "${toolId}" not found for platform "${platform}"`);
    }
    return await tool.execute(args);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export async function spawnChatopsBotToolAndCall(req: ChatopsBotToolRequest): Promise<unknown> {
  const servers =
    req.platform === "slack"
      ? await chatopsSlackBotServers(req.vaultView, req.sandboxCwd)
      : await chatopsTeamsBotServers(req.vaultView, req.sandboxCwd, req.teams);
  if (servers === undefined) {
    throw new Error(`chatops: bot credentials missing for "${req.platform}" (fail-closed)`);
  }
  const client = new MCPClient({ id: `nimbus-chatops-${req.platform}-${randomUUID()}`, servers });
  return runBotToolCall(client, req.platform, req.toolId, req.args);
}
```

(Keep all existing imports — `randomUUID`, `MCPClient`, the builders, `listLazyMeshClientTools`, `NimbusVault`, `ChatopsTeamsSpawnOpts` — and the `ChatopsBotToolRequest` interface, unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/gateway && bun test src/chatops/chatops-bot-spawn-call.test.ts`
Expected: PASS (4 existing fail-closed + 5 new dispatch tests = 9).

- [ ] **Step 5: Drop the exclusion**

In `scripts/coverage-floor/exclusions.ts`, delete the comment block + entry for `chatops-bot-spawn-call.ts`:

```ts
  // `chatops-bot-spawn-call.ts` (Phase 6 Slice 5): the ephemeral bot-credentialed spawn-and-call —
  // ... (full comment block) ...
  { kind: "exact", path: "packages/gateway/src/chatops/chatops-bot-spawn-call.ts" },
```

- [ ] **Step 6: Typecheck + lint**

Run: `cd packages/gateway && bunx tsc --noEmit` then from repo root `bunx biome check packages/gateway/src/chatops/chatops-bot-spawn-call.ts packages/gateway/src/chatops/chatops-bot-spawn-call.test.ts scripts/coverage-floor/exclusions.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/chatops/chatops-bot-spawn-call.ts \
        packages/gateway/src/chatops/chatops-bot-spawn-call.test.ts \
        scripts/coverage-floor/exclusions.ts
git commit -m "test(coverage-D1): un-exclude chatops-bot-spawn-call via runBotToolCall extract (I15/I23-safe)"
```

---

## Task 4: Invariants + whole-suite + structure-audit verification

**Files:** none (verification only).

- [ ] **Step 1: Security invariants hold**

Run: `cd packages/gateway && bun test src/security-invariants.test.ts`
Expected: PASS (69/69) — the I19/I15/I23 wiring is untouched (only added exports).

- [ ] **Step 2: Static structure audit (D10/D15/D17) passes**

Run (repo root): `bun run audit:invariants`
Expected: exit 0 — no `'teamvault.'` prefix composed outside `team-vault-keys.ts`; no new `ServerSpec` authored; no lazy-mesh I15 drift.

- [ ] **Step 3: Exclusions unit tests still pass**

Run: `bun test scripts/coverage-floor/exclusions.test.ts`
Expected: PASS (no assertions referenced the 3 removed files — verified 2026-06-13).

- [ ] **Step 4: Full gateway suite + tsc green (no cross-file leakage)**

Run: `cd packages/gateway && bunx tsc --noEmit && bun test src/teamvault src/chatops src/federation`
Expected: PASS.

- [ ] **Step 5: Commit (only if any fix was needed; otherwise skip)**

```bash
git commit -am "test(coverage-D1): verification fixups" # only if Step 1-4 required changes
```

---

## Task 5: Coverage-floor closure (CI-Linux-authoritative)

**Files:** `docs/structure-audit/coverage-baseline.json` (reseed only if needed — expected to stay `{}`).

This is the spec §5 reseed procedure. The 3 files clearing ≥80% means they simply rejoin the floor; since baseline `files` is `{}`, **no baseline entry is added** — a clean D1 PR keeps `files: {}` and the `targets` overlay (executor/envelope @ 100) untouched.

- [ ] **Step 1: Local Docker dry-run (Linux-authoritative proxy)**

Run (repo root): `bash scripts/coverage-floor/reseed-docker.sh` (recipe: `oven/bun:latest`, `-e CI=true`, apt git+libsecret-tools+gnome-keyring+dbus, wrapped in `run-with-optional-dbus.sh`, anchored `--exclude=./coverage`, named volume `nimbus-bun-cache`).
Then inspect: confirm `team-tool-spawn.ts`, `mdns-discovery-provider.ts`, `chatops-bot-spawn-call.ts` each report ≥80% line **and** branch in the produced `coverage/lcov.info`, and that `bun run audit:coverage-floor` exits 0 with `files` still `{}`.

**Contingency (chatops borderline):** `chatops-bot-spawn-call.ts` has ~2–3 irreducible uncovered lines (`new MCPClient` + the `return runBotToolCall(...)` call). If the Docker lcov shows it **below 80%**, honest-shrink says **demote it**: revert Task 3 (restore the exclusion + comment, keep the `runBotToolCall` extract + tests as a coverage improvement on the still-excluded file is pointless, so revert the whole Task 3 commit) and ship D1 with the 2 cleanly-clearing files. Record the demotion in the spec §3(a) "demoted after read" list. `team-tool-spawn` (~95%) and `mdns` (~100%) are not at risk.

- [ ] **Step 2: Push the branch + open the PR**

```bash
git push -u origin dev/asafgolombek/true-coverage-D
gh pr create --base main \
  --title "True Coverage D1: un-exclude 3 gateway I/O shells (mdns, team-tool-spawn, chatops-bot-spawn-call)" \
  --body "Sub-project D (final True Coverage tail), slice D1. Honest-shrink un-excludes three gateway I/O shells from the coverage-floor exclusions list by extracting their testable logic behind clean seams:

- federation/mdns-discovery-provider.ts — injectable bonjour factory (structural-interface seam); find-callback host-extraction + lifecycle now unit-tested against a broadcast-free fake.
- teamvault/team-tool-spawn.ts — extracted runSpawnedToolCall + exported spawnerFor; spawn/call/not-found/disconnect lifecycle tested with a fake spawner (no subprocess). I19/D15 held (public signature unchanged; real spawners still carry I1/I15).
- chatops/chatops-bot-spawn-call.ts — extracted runBotToolCall; dispatch/not-found/disconnect tested with a fake client. I15/I23 held.

Coverage: baseline files stays {} (all three clear the floor with headroom); the targets overlay (executor/envelope @ 100) is untouched. security-invariants 69/69 + audit:invariants green."
```

- [ ] **Step 3: Reseed the committed baseline from the PR's OWN merge-commit lcov (the ironclad rule)**

After the first `Unit + Coverage` CI run finishes (pass or fail):

```bash
gh run download <pr-run-id> -n coverage-lcov-merged
cp <downloaded>/lcov.info coverage/lcov.info
bun run audit:coverage-floor:update-baseline
git diff docs/structure-audit/coverage-baseline.json   # expect: no change (files stays {}) OR only legitimate drift
```

If the diff is empty (expected — the 3 files clear ≥80 with full headroom, adding no `files` entry), there is nothing to reseed. If an **untouched** file drifts across the floor, apply the spec §5 disambiguation (env vs incidental vs stale-watermark) using this same merge lcov — never guess from main. Confirm the `targets` overlay (executor/envelope @ 100/100) round-tripped unchanged.

- [ ] **Step 4: Commit any reseed + push; drive CI green**

```bash
git add docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage-D1): reseed baseline from PR merge lcov" # only if Step 3 produced a diff
git push
```

Authoritative gate = **"PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage"** + **SonarCloud**. The windows-2025 cross-platform red is the chronic flake → rerun. Run `bun run lint:markdown` from inside the worktree before pushing docs. Fix + resolve every CodeRabbit + Sonar thread (branch protection blocks merge on unresolved conversations). Keep-as-is for the user's squash-merge.

- [ ] **Step 5: Hand back for user squash-merge**

Report the green authoritative gates + the per-file coverage numbers; do not merge (user squash-merges).
