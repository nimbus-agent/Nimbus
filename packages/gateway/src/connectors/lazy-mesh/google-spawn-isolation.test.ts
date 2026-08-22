import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { getConnectorHealth } from "../health.ts";
import { ensureGoogleDriveMcp } from "./connector-spawns.ts";
import { LAZY_MESH } from "./keys.ts";
import type { MeshSpawnContext, ServerSpec } from "./slot.ts";

/**
 * F11 — one dead Google credential must not disable the other three Google connectors.
 *
 * `ensureGoogleDriveMcp` boots ONE mesh slot holding Drive, Gmail, Photos and Meet, and
 * `assemble-sync-registrations.ts` wires gmail's / photos' / meet's `ensureGoogleMcpRunning`
 * to it. So the loop that resolves a token per service is a shared fate: it used to `await
 * getValidGoogleAccessToken(...)` unguarded, and `google_drive` is first in the list.
 *
 * Observed in production: Drive's and Photos' refresh tokens had expired months earlier while
 * Gmail's was valid and accepted by Google. Every `nimbus connector sync gmail` failed with
 * `invalid_grant: Bad Request` — Drive's error, attributed to Gmail — and re-authing gmail
 * could never fix it. Note the asymmetry the guard already had: an ABSENT credential was
 * skipped by the `resolved === null` check, so deleting the vault key worked where
 * `nimbus connector pause google_drive` did not (pause gates the scheduler, not this call).
 *
 * A malformed stored payload is the deterministic stand-in for "present but unrefreshable":
 * `getValidVaultOAuthAccessToken` rejects it at parse time, before any network call, which is
 * the same control-flow position a rejected refresh reaches.
 */

const VALID_TOKEN = JSON.stringify({
  accessToken: "ya29.valid",
  refreshToken: "1//refresh",
  expiresAt: Date.now() + 3_600_000,
});

/** Present, non-empty, and unparseable — so the token resolve throws without networking. */
const DEAD_TOKEN = "not-json-at-all";

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function healthDb(): Database {
  // The real schema, not a hand-written stand-in: `transitionHealth` reads `sync_state`, not a
  // `connector_health` table, and a fixture that guesses the shape fails for the wrong reason.
  const db = new Database(":memory:");
  openDbs.push(db);
  LocalIndex.ensureSchema(db);
  return db;
}

interface Harness {
  readonly ctx: MeshSpawnContext;
  readonly warnings: Array<{ bindings: Record<string, unknown>; msg?: string }>;
  serverIds(): string[];
  clientWasSet(): boolean;
}

function harness(vault: NimbusVault, db?: Database): Harness {
  const warnings: Array<{ bindings: Record<string, unknown>; msg?: string }> = [];
  // `MCPClient` exposes the map it was constructed with as `serverConfigs`. Reading an
  // internal is the trade for observing WHICH connectors booted without spawning any of
  // them; the alternative — asserting only on the health/log side effects — would leave the
  // central claim of this file, "the other three still start", untested.
  const clients = new Map<string, { serverConfigs: Record<string, ServerSpec> }>();
  const ctx: MeshSpawnContext = {
    vault,
    logger: {
      warn: (bindings, msg): void => {
        warnings.push(msg === undefined ? { bindings } : { bindings, msg });
      },
    },
    ...(db === undefined ? {} : { healthDb: db }),
    sandboxCwd: process.cwd(),
    clearLazyIdle: (): void => {},
    getLazyClient: (): undefined => undefined,
    setLazyClient: (key, client): void => {
      clients.set(key, client as unknown as { serverConfigs: Record<string, ServerSpec> });
    },
    bumpToolsEpoch: (): void => {},
    scheduleLazyDisconnect: (): void => {},
  };
  return {
    ctx,
    warnings,
    serverIds: (): string[] => {
      const c = clients.get(LAZY_MESH.googleBundle);
      return c === undefined ? [] : Object.keys(c.serverConfigs).sort();
    },
    clientWasSet: (): boolean => clients.has(LAZY_MESH.googleBundle),
  };
}

describe("ensureGoogleDriveMcp — a dead credential is isolated to its own service", () => {
  test("gmail still boots when google_drive's stored credential cannot be used", async () => {
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const h = harness(vault);

    await ensureGoogleDriveMcp(h.ctx);

    expect(h.serverIds()).toEqual(["gmail"]);
  });

  test("two dead credentials still leave the one healthy connector running", async () => {
    // The production shape exactly: Drive AND Photos dead, Gmail valid. Re-authing only
    // google_drive left gmail broken, because google_photos sits in the same loop.
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_photos.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const h = harness(vault);

    await ensureGoogleDriveMcp(h.ctx);

    expect(h.serverIds()).toEqual(["gmail"]);
  });

  test("the failure is attributed to the service that owns the credential", async () => {
    // `sync_state.last_error` and `connector_health_history` used to name `gmail` — the one
    // Google connector whose credential was fine — because gmail's sync was what surfaced
    // Drive's throw. Health must record google_drive.
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const db = healthDb();
    const h = harness(vault, db);

    await ensureGoogleDriveMcp(h.ctx);

    const drive = getConnectorHealth(db, "google_drive");
    expect(drive.state).toBe("error");
    expect(drive.lastError ?? "").toMatch(/vault payload/);
    expect(getConnectorHealth(db, "gmail").state).not.toBe("error");
  });

  test("it warns with the failing service id, since nothing else surfaces this", async () => {
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const h = harness(vault);

    await ensureGoogleDriveMcp(h.ctx);

    const bindings = h.warnings.map((w) => w.bindings);
    expect(bindings.some((b) => b["serviceId"] === "google_drive")).toBe(true);
  });

  test("no server is registered when EVERY credential is dead", async () => {
    // Fail-closed, and identical to the all-absent case: the slot stays empty rather than
    // holding a half-built client. Each connector's own `sync()` then throws its OWN error.
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", DEAD_TOKEN);
    const h = harness(vault);

    await ensureGoogleDriveMcp(h.ctx);

    expect(h.clientWasSet()).toBe(false);
  });

  test("all four boot when every credential resolves", async () => {
    const vault = createMockVault();
    await vault.set("google.oauth", VALID_TOKEN);
    const h = harness(vault);

    await ensureGoogleDriveMcp(h.ctx);

    expect(h.serverIds()).toEqual(["gmail", "google_drive", "google_meet", "google_photos"]);
  });
});
