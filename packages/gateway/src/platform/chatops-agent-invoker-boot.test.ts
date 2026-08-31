// FIX 1 (whole-branch review of dev/asaf/chatops-agent-intent) — boot-level red-prove.
//
// The bug: `packages/gateway/src/gateway-main.ts` bound the ChatOps `agents.*` invoker
// (`buildChatopsAgentInvoker`) AFTER `assemblePlatformServices()` had already returned, at a call
// site with no federation-identity field to read at all (`PlatformServices` carries none — see
// `platform/types.ts`). So that binding always omitted `selfIdentity`, and `ipc/agents-rpc.ts`'s
// `federatedAgentBase` fell back to a zero keypair for every chat-reachable agent that fans out to
// peers (`ghost`, `conflicts`, `huddle`, `janitor`).
//
// This file is a SEPARATE test file (not a `describe` block inside `assemble.test.ts`) because it
// is the one place in this branch that legitimately needs `mock.module` rather than DI: the
// property under test is "does `assemblePlatformServices`'s OWN internal call to
// `buildChatopsAgentInvoker` carry the real `selfIdentity`", and `assemblePlatformServices` has no
// public seam for injecting a spy around that internal call (see `bootChatopsAgentInvoker` in
// `assemble.test.ts` for the DI-based unit test of the extracted wiring function itself — this
// file is the complementary end-to-end proof that the extracted function is actually reached, with
// the right value, from a real boot). The mock wraps rather than replaces the real
// `buildChatopsAgentInvoker` (delegates to it after capturing its deps), and is restored in
// `afterAll` so no other file in this branch's combined `bun test
// packages/gateway/src/{chatops,agent-runs,platform,ipc}` run observes it mocked.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryVault } from "../../test/helpers/in-memory-vault.ts";
import type { ChatopsAgentInvokerDeps } from "../agent-runs/agent-chatops-invoke.ts";
import * as realAgentChatopsInvoke from "../agent-runs/agent-chatops-invoke.ts";
import { loadOrCreateFederationIdentity } from "../federation/federation-identity.ts";
import type { PlatformPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

const AGENT_CHATOPS_INVOKE_MODULE = "../agent-runs/agent-chatops-invoke.ts";

// CONCRETE snapshot, taken BEFORE `mock.module` runs below — `{ ...ns }` copies each CURRENT
// property VALUE into a fresh plain object, unlike the live namespace binding
// `realAgentChatopsInvoke` itself, whose properties keep resolving against whatever
// `mock.module` currently has registered for this specifier. Calling
// `realAgentChatopsInvoke.buildChatopsAgentInvoker(...)` directly inside the mock factory below
// (skipping this snapshot) was tried first and infinite-recursed — the "real" reference resolved
// to the mock itself once installed — confirmed by a runaway `bun test` process that climbed to
// ~22 GB RSS and had to be killed. `realSnapshot.buildChatopsAgentInvoker` is a concrete function
// value captured before that point and cannot be affected by the later `mock.module` call.
const realSnapshot = { ...realAgentChatopsInvoke };

let captured: ChatopsAgentInvokerDeps[] = [];

mock.module(AGENT_CHATOPS_INVOKE_MODULE, () => ({
  ...realSnapshot,
  buildChatopsAgentInvoker: (deps: ChatopsAgentInvokerDeps) => {
    captured.push(deps);
    return realSnapshot.buildChatopsAgentInvoker(deps);
  },
}));

afterAll(() => {
  mock.module(AGENT_CHATOPS_INVOKE_MODULE, () => realSnapshot);
});

// Imported AFTER the mock above is installed, so `assemble.ts`'s own static import of
// `buildChatopsAgentInvoker` resolves to the capturing wrapper.
const { assemblePlatformServices } = await import("./assemble.ts");
const { processEnvSet } = await import("./env-access.ts");

describe("FIX 1 (boot-level): the ChatOps agent invoker carries the real federation selfIdentity", () => {
  it("boots with [federation]+[chatops] enabled and wires a real, non-undefined selfIdentity into buildChatopsAgentInvoker", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-chatops-selfid-")));
    const originalSkipEmbed = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", "1");
    let services: PlatformServices | null = null;
    try {
      // Reserve a free LAN port on loopback, mDNS off — same pattern as
      // assemble.test.ts's "boots the federation block" test, so federation actually boots
      // instead of failing to bind.
      //
      // D6 (whole-branch re-review): reserving then releasing a port before the real LAN server
      // binds it is a TOCTOU — a busy CI runner could grab it in between. Left as is rather than
      // restructured: `[federation]`/`[lan]` in `nimbus.toml` need a concrete port number BEFORE
      // boot (the LAN server has no "bind 0, report back what you got" capability a test could
      // poll instead), so there is no cheap way to close this window without either changing
      // production config semantics or adding bind-retry logic to the test — both are exactly the
      // kind of restructuring this test cannot afford, since it is the only thing proving the M1
      // wire (a real `assemblePlatformServices()` boot observing the real internal
      // `buildChatopsAgentInvoker` call). The pattern is pre-existing (copied from
      // `assemble.test.ts`), not novel to this file, and a flaky test that can still catch a real
      // regression beats a restructured one that stops catching it.
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      const lanPort = probe.port;
      probe.stop();
      if (typeof lanPort !== "number") throw new Error("could not reserve a free LAN port");

      const socketBaseName = `nimbus-chatops-selfid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const paths: PlatformPaths = {
        configDir: join(tmpDir, "config"),
        dataDir: join(tmpDir, "data"),
        logDir: join(tmpDir, "logs"),
        socketPath:
          process.platform === "win32" ? `\\\\.\\pipe\\${socketBaseName}` : join(tmpDir, "g.sock"),
        extensionsDir: join(tmpDir, "extensions"),
        tempDir: join(tmpDir, "tmp"),
      };
      mkdirSync(paths.configDir, { recursive: true });
      writeFileSync(
        join(paths.configDir, "nimbus.toml"),
        [
          "[federation]",
          "enabled = true",
          "mdns_enabled = false",
          'mdns_bind = "127.0.0.1"',
          "",
          "[lan]",
          `port = ${String(lanPort)}`,
          'bind = "127.0.0.1"',
          "",
          "[chatops]",
          "enabled = true",
          "slack_enabled = true",
          'bot_vault_entry = "test-bot"',
        ].join("\n"),
      );

      const vault = makeInMemoryVault();
      // Same vault the boot uses below — `loadOrCreateFederationIdentity` is deterministic
      // (Vault-stored), so this pre-computes the identity `assemblePlatformServices` will load.
      const identity = await loadOrCreateFederationIdentity(vault);
      captured = [];

      services = await assemblePlatformServices(paths, vault);

      expect(services.chatops).toBeDefined();
      // Proves the wiring actually ran during THIS boot (not merely that the extracted function
      // works in isolation, which `bootChatopsAgentInvoker`'s own unit tests in
      // assemble.test.ts already cover).
      expect(captured.length).toBeGreaterThan(0);
      const deps = captured[captured.length - 1];
      // The exact regression this fix closes: before it, this was always `undefined`.
      expect(deps?.selfIdentity).toBeDefined();
      expect(deps?.selfIdentity).toEqual(identity);
    } finally {
      if (services !== null) {
        try {
          services.disposeSidecars?.();
        } catch {
          /* ignore */
        }
        try {
          await services.ipc.stop();
        } catch {
          /* ignore */
        }
        try {
          await services.syncScheduler.stop();
        } catch {
          /* ignore */
        }
      }
      processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", originalSkipEmbed);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* Windows handle race; harmless */
      }
    }
  }, 30000);
});
