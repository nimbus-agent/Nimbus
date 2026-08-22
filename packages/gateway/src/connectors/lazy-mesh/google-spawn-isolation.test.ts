import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { getConnectorHealth } from "../health.ts";
import { ensureGoogleDriveMcp } from "./connector-spawns.ts";
import { LAZY_MESH } from "./keys.ts";
import type { MeshSpawnContext } from "./slot.ts";

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
  clientWasSet(): boolean;
}

function harness(vault: NimbusVault, db?: Database): Harness {
  const warnings: Array<{ bindings: Record<string, unknown>; msg?: string }> = [];
  // Only WHETHER a client was built is read from the map — WHICH connectors it holds comes
  // from `ensureGoogleDriveMcp`'s return value. An earlier draft read `MCPClient`'s
  // `serverConfigs`, which passed alone and failed in the full suite: another file
  // `mock.module`s `@mastra/mcp`, and the stub has no such property.
  const clients = new Map<string, unknown>();
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
      clients.set(key, client);
    },
    bumpToolsEpoch: (): void => {},
    scheduleLazyDisconnect: (): void => {},
  };
  return {
    ctx,
    warnings,
    clientWasSet: (): boolean => clients.has(LAZY_MESH.googleBundle),
  };
}

describe("ensureGoogleDriveMcp — a dead credential is isolated to its own service", () => {
  test("gmail still boots when google_drive's stored credential cannot be used", async () => {
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const h = harness(vault);

    const registered = await ensureGoogleDriveMcp(h.ctx);

    expect(registered).toEqual(["gmail"]);
  });

  test("two dead credentials still leave the one healthy connector running", async () => {
    // The production shape exactly: Drive AND Photos dead, Gmail valid. Re-authing only
    // google_drive left gmail broken, because google_photos sits in the same loop.
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_photos.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const h = harness(vault);

    const registered = await ensureGoogleDriveMcp(h.ctx);

    expect(registered).toEqual(["gmail"]);
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
    // A CLASSIFICATION, never the provider's own error text: `postToken` builds that from
    // `tokenErrorSummary`, which reads `error_description` straight out of the remote JSON, and
    // non-negotiable 3 keeps remote-controlled strings out of logs and stored state. The full
    // message still reaches `sync_state.last_error` for google_drive via its OWN sync failure.
    expect(drive.lastError ?? "").toContain("could not be read");
    expect(drive.lastError ?? "").not.toContain("vault payload");
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

    const registered = await ensureGoogleDriveMcp(h.ctx);

    expect(registered).toEqual(["gmail", "google_drive", "google_meet", "google_photos"]);
  });
});

describe("the skip reason never carries provider-controlled text", () => {
  /**
   * `postToken` composes its message from `tokenErrorSummary`, which reads `error` and
   * `error_description` verbatim out of the provider's JSON response. Passing that through to a
   * log line and to `sync_state.last_error` puts remote-controlled text on both surfaces —
   * against non-negotiable 3, and flagged by CodeQL as `js/clear-text-logging`.
   *
   * Nothing is lost by classifying instead: google_drive's own sync still fails, still calls
   * `getValidGoogleAccessToken` for itself, and still records the full message through
   * `syncFailureUserMessage` — the correct attribution F11 exists to restore.
   */
  test("an error carrying a secret-shaped string does not reach the log or health row", async () => {
    const vault = createMockVault();
    // A stored payload whose PARSE fails is the reachable case here; the classification path is
    // shared with the refresh-rejected case, which is where provider text would arrive.
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    await vault.set("google_gmail.oauth", VALID_TOKEN);
    const db = healthDb();
    const h = harness(vault, db);

    await ensureGoogleDriveMcp(h.ctx);

    const logged = JSON.stringify(h.warnings);
    expect(logged).not.toContain("vault payload");
    expect(logged).toContain("nimbus connector auth");
    expect(getConnectorHealth(db, "google_drive").lastError ?? "").not.toContain("vault payload");
  });

  test("both classifications point at the same remedy", async () => {
    // The reason exists to be actionable. Whichever way the credential failed, re-auth is the
    // fix, and the line has to say so — a classification that only says "something went wrong"
    // would be a worse trade than the text it replaced.
    const vault = createMockVault();
    await vault.set("google_drive.oauth", DEAD_TOKEN);
    const h = harness(vault);

    await ensureGoogleDriveMcp(h.ctx);

    expect(h.warnings[0]?.bindings["reason"]).toContain("nimbus connector auth");
  });
});
