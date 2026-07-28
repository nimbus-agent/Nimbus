import {
  type ConnectorServiceId,
  defaultSyncIntervalMsForService,
  normalizeConnectorServiceId,
} from "../connectors/connector-catalog.ts";
import { writeConnectorSecret } from "../connectors/connector-vault.ts";
import { isGatewaySyncableServiceId } from "../connectors/gateway-syncable-ids.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "../connectors/user-mcp-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { countItemsForService } from "../sync/scheduler-store.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export class ConnectorRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "ConnectorRpcError";
  }
}

export { asRecord } from "../connectors/unknown-record.ts";

export function requireServiceId(rec: Record<string, unknown> | undefined): ConnectorServiceId {
  const raw = rec !== undefined && typeof rec["serviceId"] === "string" ? rec["serviceId"] : "";
  const id = normalizeConnectorServiceId(raw);
  if (id === null) {
    throw new ConnectorRpcError(-32602, "Invalid or unknown serviceId");
  }
  return id;
}

export function requireRegisteredConnector(localIndex: LocalIndex, id: ConnectorServiceId): void {
  if (localIndex.persistedConnectorStatuses(id).length === 0) {
    throw new ConnectorRpcError(-32602, `Unknown connector: ${id}`);
  }
}

export function requireRegisteredSchedulerServiceId(
  rec: Record<string, unknown> | undefined,
  localIndex: LocalIndex,
): string {
  const raw = rec !== undefined && typeof rec["serviceId"] === "string" ? rec["serviceId"] : "";
  if (raw.trim() === "") {
    throw new ConnectorRpcError(-32602, "Missing serviceId");
  }
  const trimmed = raw.trim();
  const builtIn = normalizeConnectorServiceId(trimmed);
  const id = builtIn ?? trimmed.toLowerCase();
  // The gateway-side syncables (filesystem / blame / openapi / obsidian) are
  // registered with the scheduler by assemble.ts but have no catalog entry, so
  // before they were admitted here `connector.sync` rejected all four with
  // "Invalid serviceId" — including the `nimbus connector sync filesystem`
  // that `nimbus init` and the README tell a first-time user to run.
  // This only widens which NAMES are addressable; the registration check below
  // is still what authorises the sync.
  if (
    builtIn === null &&
    !isGatewaySyncableServiceId(id) &&
    !USER_MCP_SERVICE_ID_PATTERN.test(id)
  ) {
    throw new ConnectorRpcError(-32602, "Invalid serviceId");
  }
  if (localIndex.persistedConnectorStatuses(id).length === 0) {
    throw new ConnectorRpcError(-32602, `Unknown connector: ${id}`);
  }
  return id;
}

export function resolveConnectorListFilterServiceId(raw: string): string | null {
  const t = raw.trim();
  const builtIn = normalizeConnectorServiceId(t);
  if (builtIn !== null) {
    return builtIn;
  }
  const lower = t.toLowerCase();
  if (USER_MCP_SERVICE_ID_PATTERN.test(lower)) {
    return lower;
  }
  return null;
}

export function sumItemsSiblingServices(
  db: import("bun:sqlite").Database,
  serviceId: ConnectorServiceId,
  family: ReadonlySet<string>,
): number {
  let n = 0;
  for (const s of family) {
    if (s !== serviceId) {
      n += countItemsForService(db, s);
    }
  }
  return n;
}

export function parseServiceArg(rec: Record<string, unknown> | undefined): ConnectorServiceId {
  let raw = "";
  if (rec !== undefined) {
    if (typeof rec["service"] === "string") {
      raw = rec["service"];
    } else if (typeof rec["serviceId"] === "string") {
      raw = rec["serviceId"];
    }
  }
  const id = normalizeConnectorServiceId(raw);
  if (id === null) {
    throw new ConnectorRpcError(-32602, "Invalid or unknown service");
  }
  return id;
}

type AtlassianConnectorAuthMessages = {
  missingEmail: string;
  missingToken: string;
  missingBase: string;
};

export function parseAtlassianSiteCredentials(
  rec: Record<string, unknown> | undefined,
  messages: AtlassianConnectorAuthMessages,
): { email: string; apiToken: string; baseNormalized: string } {
  const emailRaw = rec?.["atlassianEmail"] ?? rec?.["email"];
  const email = typeof emailRaw === "string" && emailRaw.trim() !== "" ? emailRaw.trim() : "";
  if (email === "") {
    throw new ConnectorRpcError(-32602, messages.missingEmail);
  }
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"] ?? rec?.["apiToken"];
  const apiToken = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
  if (apiToken === "") {
    throw new ConnectorRpcError(-32602, messages.missingToken);
  }
  const baseRaw = rec?.["apiBaseUrl"] ?? rec?.["baseUrl"];
  const baseStr = typeof baseRaw === "string" && baseRaw.trim() !== "" ? baseRaw.trim() : "";
  if (baseStr === "") {
    throw new ConnectorRpcError(-32602, messages.missingBase);
  }
  return { email, apiToken, baseNormalized: stripTrailingSlashes(baseStr) };
}

export async function registerAtlassianApiConnectorAuth(options: {
  vault: NimbusVault;
  localIndex: LocalIndex;
  serviceId: "jira" | "confluence";
  creds: { email: string; apiToken: string; baseNormalized: string };
}): Promise<{ ok: true; serviceId: ConnectorServiceId; scopesGranted: string[] }> {
  const { vault, localIndex, serviceId, creds } = options;
  await writeConnectorSecret(vault, serviceId, "email", creds.email);
  await writeConnectorSecret(vault, serviceId, "api_token", creds.apiToken);
  await writeConnectorSecret(vault, serviceId, "base_url", creds.baseNormalized);
  const interval = defaultSyncIntervalMsForService(serviceId);
  localIndex.ensureConnectorSchedulerRegistration(serviceId, interval, Date.now());
  return {
    ok: true,
    serviceId,
    scopesGranted: [] as string[],
  };
}
