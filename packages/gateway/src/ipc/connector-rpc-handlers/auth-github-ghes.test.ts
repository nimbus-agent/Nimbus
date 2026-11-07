/**
 * `connector.auth github` with a GitHub Enterprise Server base: strict validation BEFORE the probe,
 * probe-before-store, the base stored normalised (or deleted on a re-auth without one), both sync
 * cursors cleared when the instance changes and never when it does not, items never deleted, and
 * the running child retired on every outcome.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProbeVerdict } from "../../connectors/credential-probe.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/mesh.ts";
import { adoptLocalAuth } from "../../connectors/local-auth/adopt-local-auth.ts";
import type { LocalAuthHostDeps } from "../../connectors/local-auth/local-auth-host.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { setSchedulerCursor } from "../../sync/scheduler-store.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import { handleConnectorAuth } from "./auth.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";

const GHES = "https://ghe.example.com";
const GHES_ROOT = "https://ghe.example.com/api/v3";

let db: Database;
let localIndex: LocalIndex;
let vault: NimbusVault;
let events: string[];
let probedCreds: Array<Record<string, string>>;
let restarts: number;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  vault = createMockVault();
  events = [];
  probedCreds = [];
  restarts = 0;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

function ctxFor(
  fields: Record<string, unknown>,
  verdict: ProbeVerdict | null = { kind: "valid", scopes: [] },
): ConnectorRpcHandlerContext {
  return {
    rec: { service: "github", personalAccessToken: "ghp_test", ...fields },
    vault,
    localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    connectorMesh: {
      restartGithub: () => {
        restarts += 1;
      },
    } as unknown as LazyConnectorMesh,
    appendProbeEgress: (id) => {
      events.push(`egress:${id}`);
    },
    runCredentialProbe: async (id, creds) => {
      events.push(`probe:${id}`);
      probedCreds.push(creds);
      return verdict;
    },
  };
}

async function refusal(ctx: ConnectorRpcHandlerContext): Promise<ConnectorRpcError> {
  try {
    await handleConnectorAuth(ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorRpcError);
    return e as ConnectorRpcError;
  }
  throw new Error("expected connector.auth to refuse");
}

function cursorOf(id: string): string | null {
  const row = db.query("SELECT cursor FROM scheduler_state WHERE service_id = ?").get(id) as {
    cursor: string | null;
  } | null;
  return row?.cursor ?? null;
}

function seedCursors(): void {
  localIndex.ensureConnectorSchedulerRegistration("github", 60_000, 1);
  localIndex.ensureConnectorSchedulerRegistration("github_actions", 60_000, 1);
  setSchedulerCursor(db, "github", "nimbus-ghub1:abc");
  setSchedulerCursor(db, "github_actions", "nimbus-gha1:abc");
}

function seedItem(): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "o/r#1",
    title: "Kept",
    bodyPreview: "",
    url: "https://github.com/o/r/pull/1",
    canonicalUrl: null,
    modifiedAt: 1,
    metadata: { repo: "o/r" },
    syncedAt: 1,
  });
}

function itemCount(): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM item WHERE service = 'github'").get() as { n: number }
  ).n;
}

describe("connector.auth github: a failed write never leaves a PAT beside the wrong base", () => {
  test("the base write throws: no PAT remains (the old one is gone too) and the child is retired", async () => {
    await vault.set("github.pat", "ghp_old");
    await vault.set("github.api_base", GHES_ROOT);
    const failing: NimbusVault = {
      ...vault,
      get: (k) => vault.get(k),
      set: (k, v) =>
        k === "github.api_base" ? Promise.reject(new Error("vault down")) : vault.set(k, v),
      delete: (k) => vault.delete(k),
    };
    const ctx = { ...ctxFor({ apiBaseUrl: "https://other.example.com" }), vault: failing };
    await expect(handleConnectorAuth(ctx)).rejects.toThrow("vault down");
    expect(await vault.get("github.pat")).toBeNull();
    expect(restarts).toBe(1);
  });

  test("a re-auth to github.com whose base delete throws leaves no PAT", async () => {
    await vault.set("github.api_base", GHES_ROOT);
    const failing: NimbusVault = {
      ...vault,
      get: (k) => vault.get(k),
      set: (k, v) => vault.set(k, v),
      delete: (k) =>
        k === "github.api_base" ? Promise.reject(new Error("vault down")) : vault.delete(k),
    };
    const ctx = { ...ctxFor({}), vault: failing };
    await expect(handleConnectorAuth(ctx)).rejects.toThrow("vault down");
    expect(await vault.get("github.pat")).toBeNull();
  });
});

describe("connector.auth github with an api base", () => {
  test("stores github.api_base normalised and probes with the normalised base", async () => {
    await handleConnectorAuth(ctxFor({ apiBaseUrl: " HTTPS://GHE.example.com/ " }));
    expect(await vault.get("github.api_base")).toBe(GHES_ROOT);
    expect(await vault.get("github.pat")).toBe("ghp_test");
    expect(probedCreds).toEqual([{ pat: "ghp_test", api_base: GHES_ROOT }]);
  });

  test("the api_base alias is accepted too", async () => {
    await handleConnectorAuth(ctxFor({ api_base: GHES }));
    expect(await vault.get("github.api_base")).toBe(GHES_ROOT);
  });

  test("a re-auth without a base deletes a previously stored one and probes github.com", async () => {
    await vault.set("github.api_base", GHES_ROOT);
    await handleConnectorAuth(ctxFor({}));
    expect(await vault.get("github.api_base")).toBeNull();
    expect(probedCreds).toEqual([{ pat: "ghp_test" }]);
  });

  test("an http base throws -32602, stores neither pat nor base, and never probes", async () => {
    const err = await refusal(ctxFor({ apiBaseUrl: "http://ghe.secret-host.example.com" }));
    expect(err.rpcCode).toBe(-32602);
    expect(await vault.get("github.pat")).toBeNull();
    expect(await vault.get("github.api_base")).toBeNull();
    expect(events).toEqual([]);
  });

  test("each invalid base is refused before the probe, and the error text never carries the URL", async () => {
    for (const bad of [
      "https://user:pw@ghe.secret-host.example.com",
      "https://ghe.secret-host.example.com/api/v4",
      "https://ghe.secret-host.example.com?x=1",
      "https://github.com",
      "https://acme.ghe.com",
      "https://localhost",
      "https://169.254.169.254",
      "not a url",
    ]) {
      const err = await refusal(ctxFor({ apiBaseUrl: bad }));
      expect(err.rpcCode).toBe(-32602);
      expect(err.message).not.toContain("secret-host");
      expect(err.message).not.toContain("user:pw");
      expect(err.message).not.toContain(bad);
    }
    expect(events).toEqual([]);
    expect(await vault.get("github.pat")).toBeNull();
  });

  test("a non-string base is refused", async () => {
    const err = await refusal(ctxFor({ apiBaseUrl: 42 }));
    expect(err.rpcCode).toBe(-32602);
    expect(events).toEqual([]);
  });

  test("the I29 egress row is appended BEFORE the probe, for a GHES base too", async () => {
    await handleConnectorAuth(ctxFor({ apiBaseUrl: GHES }));
    expect(events).toEqual(["egress:github", "probe:github"]);
  });

  test("a rejected probe against the GHES base stores nothing and does not clear cursors", async () => {
    seedCursors();
    await expect(
      handleConnectorAuth(ctxFor({ apiBaseUrl: GHES }, { kind: "rejected", httpStatus: 401 })),
    ).rejects.toThrow(/rejected the credential/);
    expect(await vault.get("github.pat")).toBeNull();
    expect(await vault.get("github.api_base")).toBeNull();
    expect(cursorOf("github")).toBe("nimbus-ghub1:abc");
    expect(cursorOf("github_actions")).toBe("nimbus-gha1:abc");
  });
});

describe("cursor invalidation lives in connector.auth github", () => {
  test("changing the base (github.com to GHES) clears BOTH cursors and keeps every item", async () => {
    seedCursors();
    seedItem();
    await handleConnectorAuth(ctxFor({ apiBaseUrl: GHES }));
    expect(cursorOf("github")).toBeNull();
    expect(cursorOf("github_actions")).toBeNull();
    expect(itemCount()).toBe(1);
  });

  test("changing from one instance to another clears both cursors", async () => {
    await vault.set("github.api_base", GHES_ROOT);
    seedCursors();
    await handleConnectorAuth(ctxFor({ apiBaseUrl: "https://other.example.com" }));
    expect(cursorOf("github")).toBeNull();
    expect(cursorOf("github_actions")).toBeNull();
  });

  test("returning to github.com (no base) clears both cursors", async () => {
    await vault.set("github.api_base", GHES_ROOT);
    seedCursors();
    seedItem();
    await handleConnectorAuth(ctxFor({}));
    expect(cursorOf("github")).toBeNull();
    expect(cursorOf("github_actions")).toBeNull();
    expect(itemCount()).toBe(1);
  });

  test("an UNCHANGED base keeps both cursors (a plain PAT rotation, on GHES and on github.com)", async () => {
    await vault.set("github.api_base", GHES_ROOT);
    seedCursors();
    await handleConnectorAuth(ctxFor({ apiBaseUrl: GHES_ROOT }));
    expect(cursorOf("github")).toBe("nimbus-ghub1:abc");
    expect(cursorOf("github_actions")).toBe("nimbus-gha1:abc");

    await vault.delete("github.api_base");
    await handleConnectorAuth(ctxFor({}));
    expect(cursorOf("github")).toBe("nimbus-ghub1:abc");
    expect(cursorOf("github_actions")).toBe("nimbus-gha1:abc");
  });

  test("the first-ever auth against a GHES registers both services and does not throw", async () => {
    await handleConnectorAuth(ctxFor({ apiBaseUrl: GHES }));
    expect(cursorOf("github")).toBeNull();
    const n = (db.query("SELECT COUNT(*) AS n FROM scheduler_state").get() as { n: number }).n;
    expect(n).toBe(2);
  });
});

describe("the github child is retired on every outcome past validation", () => {
  test("a successful auth retires the slot", async () => {
    await handleConnectorAuth(ctxFor({ apiBaseUrl: GHES }));
    expect(restarts).toBe(1);
  });

  test("a failure after validation (the write path throws) still retires the slot", async () => {
    const ctx = ctxFor({ apiBaseUrl: GHES });
    const failing: NimbusVault = {
      get: (k) => vault.get(k),
      listKeys: (p) => vault.listKeys(p),
      delete: (k) => vault.delete(k),
      set: async () => {
        throw new Error("vault write failed");
      },
    };
    await expect(handleConnectorAuth({ ...ctx, vault: failing })).rejects.toThrow(
      /vault write failed/,
    );
    expect(restarts).toBe(1);
  });

  test("a refused (invalid) auth makes no write and so does not need to retire anything", async () => {
    await refusal(ctxFor({ apiBaseUrl: "http://ghe.example.com" }));
    expect(restarts).toBe(0);
  });
});

describe("a gh adoption inherits the same handler: probe against the GHES base and the cursor rule", () => {
  const TOKEN = "gho_0123456789abcdefghij0123456789";
  const hostDeps: LocalAuthHostDeps = {
    run: async () => ({ ok: true, stdout: `${TOKEN}\n`, stderr: "", code: 0 }),
    which: () => true,
    readFile: () => "ghe.example.com:\n    user: me\n",
    exists: () => true,
    env: {},
    platform: "linux",
    homeDir: "/home/u",
  };

  function adopt(host: string | undefined, hosts: string): Promise<unknown> {
    return adoptLocalAuth(
      { source: "gh", ...(host === undefined ? {} : { host }), replace: true },
      {
        detect: { host: { ...hostDeps, readFile: () => hosts }, isConfigured: async () => false },
        gate: async () => "proceed",
        authenticate: (rec) => handleConnectorAuth({ ...ctxFor({}), rec }),
        readGcpKeyPath: async () => null,
      },
    );
  }

  test("the adoption probe goes to the GHES base (not api.github.com) and stores the base", async () => {
    await adopt("ghe.example.com", "ghe.example.com:\n    user: me\n");
    expect(probedCreds).toEqual([{ pat: TOKEN, api_base: GHES_ROOT }]);
    expect(await vault.get("github.api_base")).toBe(GHES_ROOT);
    expect(events).toEqual(["egress:github", "probe:github"]);
  });

  test("adopting a different instance clears both cursors; the same instance clears neither", async () => {
    await vault.set("github.api_base", "https://other.example.com/api/v3");
    seedCursors();
    seedItem();
    await adopt("ghe.example.com", "ghe.example.com:\n    user: me\n");
    expect(cursorOf("github")).toBeNull();
    expect(cursorOf("github_actions")).toBeNull();
    expect(itemCount()).toBe(1);

    seedCursors();
    await adopt("ghe.example.com", "ghe.example.com:\n    user: me\n");
    expect(cursorOf("github")).toBe("nimbus-ghub1:abc");
    expect(cursorOf("github_actions")).toBe("nimbus-gha1:abc");
  });

  test("adopting github.com while a GHES is stored deletes the base and clears both cursors", async () => {
    await vault.set("github.api_base", GHES_ROOT);
    seedCursors();
    await adopt(undefined, "github.com:\n    user: me\n");
    expect(await vault.get("github.api_base")).toBeNull();
    expect(cursorOf("github")).toBeNull();
    expect(cursorOf("github_actions")).toBeNull();
  });
});
