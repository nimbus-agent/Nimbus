import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import type { ChatopsBoot } from "../../chatops/chatops-boot.ts";
import type { ReplyTarget } from "../../chatops/types.ts";
import { DEFAULT_NIMBUS_CHATOPS_TOML, type NimbusChatopsToml } from "../../config/nimbus-toml.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import type { TribalBoot } from "../../tribal/tribal-boot.ts";
import { processEnvGet, processEnvSet } from "../env-access.ts";
import { createLinuxPaths } from "../paths.ts";
import { bootChatopsIntoAssembly } from "./chatops-boot.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";
import type { createSchedulerWithMesh } from "./scheduler-mesh.ts";

type IpcOpts = Parameters<typeof createIpcServer>[0];
type Mesh = Awaited<ReturnType<typeof createSchedulerWithMesh>>["connectorMesh"];

const SINK_ENV = "NIMBUS_CHATOPS_E2E_SINK_DIR";

describe("bootChatopsIntoAssembly", () => {
  let root: string;
  let db: Database;
  let savedSink: string | undefined;
  let warnings: string[];
  let stops: Array<() => void>;
  let ipcOpts: IpcOpts;
  let httpOpts: HttpSidecarOpts;
  let booted: ChatopsBoot[];

  const syncLogger = {
    warn: (m: unknown) => {
      warnings.push(String(m));
    },
    error: () => {},
  } as unknown as Logger;

  const policyGate = {
    enforced: () => ({
      retentionDays: 30,
      retentionMinDays: 0,
      hitlRequired: new Set<string>(),
      quorum: new Map(),
      capabilitiesDisabled: new Set<string>(),
      connectorAllow: undefined,
      chatops: { channels: new Map(), ownership: new Map() },
    }),
    status: () => ({ signatureValid: false, pendingRestart: false, source: "none" }),
    governanceIntended: () => false,
  } as unknown as Parameters<typeof bootChatopsIntoAssembly>[0]["policyGate"];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "assemble-chatops-"));
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    savedSink = processEnvGet(SINK_ENV);
    processEnvSet(SINK_ENV, root);
    warnings = [];
    stops = [];
    booted = [];
    ipcOpts = {} as unknown as IpcOpts;
    httpOpts = {};
  });

  afterEach(async () => {
    for (const b of booted) await b.stop();
    processEnvSet(SINK_ENV, savedSink);
    db.close();
    rmDirWithRetry(root);
  });

  function deps(
    over: Partial<Parameters<typeof bootChatopsIntoAssembly>[0]> = {},
    cfg: Partial<NimbusChatopsToml> = {},
  ): Parameters<typeof bootChatopsIntoAssembly>[0] {
    return {
      chatopsCfg: { ...DEFAULT_NIMBUS_CHATOPS_TOML, enabled: true, ...cfg },
      policyGate,
      tribalBoot: undefined,
      tribalInterceptCommand: undefined,
      identityBoot: undefined,
      vault: makeInMemoryVault(),
      paths: { ...createLinuxPaths(), sandboxDir: join(root, "sandbox") },
      db,
      connectorMesh: {} as unknown as Mesh,
      syncLogger,
      ipcOpts,
      httpSidecarOpts: httpOpts,
      sidecarStops: stops,
      tribalSendHolder: { current: async () => {} },
      chatopsAllowedByBootPolicy: true,
      watcherPinnedChannel: undefined,
      connectorWriteDeps: {} as never,
      ...over,
    };
  }

  async function boot(
    over: Partial<Parameters<typeof bootChatopsIntoAssembly>[0]> = {},
    cfg: Partial<NimbusChatopsToml> = {},
  ): Promise<ChatopsBoot | undefined> {
    const b = await bootChatopsIntoAssembly(deps(over, cfg));
    if (b !== undefined) booted.push(b);
    return b;
  }

  test("[chatops] disabled boots nothing and touches no option", async () => {
    expect(await boot({}, { enabled: false })).toBeUndefined();
    expect(ipcOpts.chatopsRpcCtx).toBeUndefined();
    expect(stops).toEqual([]);
  });

  test("a boot policy that forbids ChatOps (a demo gateway, I41) wins over an enabled config", async () => {
    expect(await boot({ chatopsAllowedByBootPolicy: false })).toBeUndefined();
    expect(ipcOpts.chatopsRpcCtx).toBeUndefined();
    expect(stops).toEqual([]);
  });

  test("an enabled boot wires the RPC context and one stop, and no Teams surface without Teams", async () => {
    const b = await boot();
    expect(b).toBeDefined();
    expect(ipcOpts.chatopsRpcCtx).toBe(b?.rpcCtx as NonNullable<IpcOpts["chatopsRpcCtx"]>);
    expect(stops).toHaveLength(1);
    expect(httpOpts.resolveTeamsEventsSurface).toBeUndefined();
  });

  test("Teams with a bot app id registers the Teams events surface on the HTTP sidecar", async () => {
    const b = await boot({}, { teamsEnabled: true, teamsBotAppId: "app-id" });
    expect(b?.teamsSurface).toBeDefined();
    expect(await httpOpts.resolveTeamsEventsSurface?.()).toBe(b?.teamsSurface);
  });

  test("Teams without a bot app id registers no surface (the route stays 404)", async () => {
    await boot({}, { teamsEnabled: true, teamsBotAppId: "" });
    expect(httpOpts.resolveTeamsEventsSurface).toBeUndefined();
  });

  test("a tribal boot rebinds the tribal reply holder to ChatOps' own reply seam", async () => {
    const noop = async (_t: ReplyTarget, _s: string): Promise<void> => {};
    const holder = { current: noop };
    const tribalBoot = {
      onInboundMessage: async () => {},
    } as unknown as TribalBoot;
    const b = await boot({ tribalBoot, tribalSendHolder: holder });
    expect(b).toBeDefined();
    expect(holder.current).not.toBe(noop);
  });

  test("without a tribal boot the holder stays the no-op", async () => {
    const noop = async (_t: ReplyTarget, _s: string): Promise<void> => {};
    const holder = { current: noop };
    await boot({ tribalSendHolder: holder });
    expect(holder.current).toBe(noop);
  });

  test("the owner's pinned watcher channel posts through the sink when no org policy governs ChatOps", async () => {
    const b = await boot({ watcherPinnedChannel: "C0123456789" }, { slackEnabled: true });
    expect(await b?.postWatcherNoticePinned("notice")).toBe(1);
    const ledgered = db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number };
    expect(ledgered.n).toBe(1);
    const posts = readFileSync(join(root, "mock-chatops-sink.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(posts).toEqual([
      { kind: "chat_post", platform: "slack", channel: "C0123456789", text: "notice" },
    ]);
  });

  test("an install that is under (or was meant to be under) an org policy never posts to the pin", async () => {
    const governed = { ...policyGate, governanceIntended: () => true } as typeof policyGate;
    const b = await boot(
      { watcherPinnedChannel: "C0123456789", policyGate: governed },
      { slackEnabled: true },
    );
    expect(await b?.postWatcherNoticePinned("notice")).toBe(0);
    expect(existsSync(join(root, "mock-chatops-sink.ndjson"))).toBe(false);
  });

  test("a pin that is not a Slack channel id is ignored, not posted to", async () => {
    const b = await boot({ watcherPinnedChannel: "general" }, { slackEnabled: true });
    expect(await b?.postWatcherNoticePinned("notice")).toBe(0);
  });

  test("a Slack-less ChatOps never posts to the pin", async () => {
    const b = await boot({ watcherPinnedChannel: "C0123456789" }, { slackEnabled: false });
    expect(await b?.postWatcherNoticePinned("notice")).toBe(0);
    expect(existsSync(join(root, "mock-chatops-sink.ndjson"))).toBe(false);
  });

  test("with the sink unset or empty a post goes to the real bot-credentialed transport, never the file sink", async () => {
    const withChannel = {
      ...policyGate,
      enforced: () => ({
        ...policyGate.enforced(),
        chatops: {
          channels: new Map([
            ["C0123456789", { namespace: "eng", unmapped: "refuse", notify: ["C0123456789"] }],
          ]),
          ownership: new Map(),
        },
      }),
    } as unknown as typeof policyGate;
    for (const unset of [undefined, ""]) {
      processEnvSet(SINK_ENV, unset);
      const b = await boot({ policyGate: withChannel }, { slackEnabled: true });
      // The post reaches a destination (one notify channel) and so runs the transport. The real one
      // has no bot credentials in this empty vault, so it fails; the sink would have succeeded.
      await expect(b?.postWatcherNotice("eng", "n")).rejects.toThrow();
      expect(existsSync(join(root, "mock-chatops-sink.ndjson"))).toBe(false);
    }
  });

  test("a tribal command interceptor and a tribal inbound hook are accepted by the boot", async () => {
    const tribalBoot = { onInboundMessage: async () => {} } as unknown as TribalBoot;
    const b = await boot({ tribalBoot, tribalInterceptCommand: async () => false });
    expect(b).toBeDefined();
    expect(stops).toHaveLength(1);
  });

  describe("identity (I18) as ChatOps sees it", () => {
    const ISSUER = "https://idp.example.com";

    function seed(opts: { scimEmail: string | null; sessionExpiresIn: number }): IdentityBootLike {
      const store = new IdentityStore(db);
      store.upsertScimUser(
        { externalId: "ext-bob", userName: "bob", email: opts.scimEmail, active: true, attrs: {} },
        1,
      );
      store.upsertSession({
        issuer: ISSUER,
        externalId: "ext-bob",
        email: "bob@acme.com",
        validatedAt: 1,
        expiresAt: Date.now() + opts.sessionExpiresIn,
        status: "active",
      });
      return { store, issuer: ISSUER, graceSeconds: 0 };
    }
    type IdentityBootLike = { store: IdentityStore; issuer: string; graceSeconds: number };
    const asBoot = (b: IdentityBootLike) =>
      b as unknown as Parameters<typeof bootChatopsIntoAssembly>[0]["identityBoot"];

    beforeEach(() => {
      writeFileSync(
        join(root, "mock-chatops.json"),
        JSON.stringify({ wsUrl: "", users: { U_BOB: "bob@acme.com", U_NOBODY: "x@acme.com" } }),
      );
    });

    test("a chat user whose email is an enrolled SCIM user with a live operator session is mapped", async () => {
      const b = await boot({
        identityBoot: asBoot(seed({ scimEmail: "bob@acme.com", sessionExpiresIn: 60_000 })),
      });
      expect(await b?.isSenderMapped("slack", "U_BOB")).toBe(true);
    });

    test("a SCIM record that carries no email is still mapped under the email the chat lookup found", async () => {
      const real = seed({ scimEmail: "bob@acme.com", sessionExpiresIn: 60_000 });
      const emailless = {
        ...real,
        store: {
          findScimByEmail: (e: string) => {
            const m = real.store.findScimByEmail(e);
            return m === undefined ? undefined : { ...m, email: undefined };
          },
          getSession: (issuer: string) => real.store.getSession(issuer),
        },
      };
      const b = await boot({ identityBoot: asBoot(emailless as unknown as IdentityBootLike) });
      expect(await b?.isSenderMapped("slack", "U_BOB")).toBe(true);
    });

    test("a SCIM user who is no longer active is unmapped", async () => {
      const real = seed({ scimEmail: "bob@acme.com", sessionExpiresIn: 60_000 });
      real.store.upsertScimUser(
        { externalId: "ext-bob", userName: "bob", email: "bob@acme.com", active: false, attrs: {} },
        2,
      );
      const b = await boot({ identityBoot: asBoot(real) });
      expect(await b?.isSenderMapped("slack", "U_BOB")).toBe(false);
    });

    test("an email with no SCIM user is unmapped", async () => {
      const b = await boot({
        identityBoot: asBoot(seed({ scimEmail: "bob@acme.com", sessionExpiresIn: 60_000 })),
      });
      expect(await b?.isSenderMapped("slack", "U_NOBODY")).toBe(false);
    });

    test("an enrolled user whose operator session has expired is unmapped (fails closed)", async () => {
      const b = await boot({
        identityBoot: asBoot(seed({ scimEmail: "bob@acme.com", sessionExpiresIn: -60_000 })),
      });
      expect(await b?.isSenderMapped("slack", "U_BOB")).toBe(false);
    });

    test("with identity disabled every sender is unmapped", async () => {
      const b = await boot();
      expect(await b?.isSenderMapped("slack", "U_BOB")).toBe(false);
    });
  });
});
