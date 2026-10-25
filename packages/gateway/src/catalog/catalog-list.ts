// The catalog an owner browses: the built-in agents (with whether each is currently visible), then
// every connector on this install - built-in, installed extension, owner-registered MCP server.
//
// Presentation only. Nothing here gates anything; visibility comes from `agent-visibility.ts`.
// Owner-added text (an extension's manifest name, a user MCP server's id) is returned RAW: it is
// data, and the CLI strips terminal control characters before printing it.

import type { Database } from "bun:sqlite";
import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import type { ConfigSnapshot } from "../config/layered-config.ts";
import { CONNECTOR_SERVICE_IDS, UNBUNDLED_CONNECTOR_IDS } from "../connectors/connector-catalog.ts";
import { GATEWAY_SYNCABLE_SERVICE_IDS } from "../connectors/gateway-syncable-ids.ts";
import { listUserMcpConnectors } from "../connectors/user-mcp-store.ts";
import { readVerifiedManifest } from "../extensions/approve-run.ts";
import { listRunGrants } from "../extensions/run-grant-store.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { CATALOG_AGENT_NAMES, type CatalogAgent, listCatalogAgents } from "./agent-catalog.ts";
import { describeAgentVisibility, resolveAgentVisibility } from "./agent-visibility.ts";
import {
  CONNECTOR_CATALOG_META,
  type ConnectorCategory,
  type ConnectorMeta,
} from "./connector-catalog-meta.ts";

export type CatalogConnector =
  | {
      readonly kind: "builtin";
      readonly id: string;
      readonly displayName: string;
      readonly category: ConnectorCategory;
      readonly description: string;
      /** How onboarding offers its sign-in (derived from the gateway's auth table). */
      readonly signIn: ConnectorSignInKind;
    }
  | {
      readonly kind: "extension";
      readonly id: string;
      readonly serviceId: string | null;
      readonly name: string | null;
      readonly category: "extension";
    }
  | {
      readonly kind: "user-mcp";
      readonly id: string;
      readonly name: string;
      readonly category: "user-mcp";
    };

export type CatalogListResult = {
  readonly agents: readonly (CatalogAgent & { readonly visible: boolean })[];
  readonly connectors: readonly CatalogConnector[];
  /**
   * The connectors onboarding and the connector screens suggest, in order: the active packs'
   * suggestions, or {@link NEUTRAL_SUGGESTED_CONNECTORS} when no pack suggests any; ids not on this
   * install are dropped. Presentation only.
   */
  readonly suggestedConnectors: readonly string[];
  readonly visibility: {
    readonly basis: "all" | "packs";
    readonly packs: readonly string[];
    readonly notes: readonly string[];
  };
};

const EXTENSION_NAME_MAX = 200;

/** Same values as `ipc/connector-rpc-handlers/auth.ts`; declared here so catalog/ imports no ipc/. */
export type ConnectorSignInKind = "browser" | "atlassian" | "terminal";

/** Suggested with no active pack: the six the desktop onboarding always showed, as ids. */
export const NEUTRAL_SUGGESTED_CONNECTORS = [
  "google_drive",
  "slack",
  "notion",
  "gmail",
  "github",
  "linear",
] as const;

function extensionName(row: ExtensionRow): string | null {
  try {
    const name = readVerifiedManifest(row).name?.trim();
    return name === undefined || name === "" ? null : name.slice(0, EXTENSION_NAME_MAX);
  } catch {
    return null;
  }
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return codeUnitCompare(a.id, b.id);
}

const META_BY_ID: Readonly<Record<string, ConnectorMeta>> = CONNECTOR_CATALOG_META;

/** The connectors that ship built in: bundled ones, then the gateway-syncable ones. */
export function builtinCatalogConnectorIds(): readonly string[] {
  // An unbundled connector ships as a signed extension: it is listed once, as the installed
  // extension, never as built in.
  const unbundled: ReadonlySet<string> = new Set(UNBUNDLED_CONNECTOR_IDS);
  return [
    ...CONNECTOR_SERVICE_IDS.filter((id) => !unbundled.has(id)),
    ...GATEWAY_SYNCABLE_SERVICE_IDS,
  ];
}

export function buildCatalogList(deps: {
  readonly db: Database;
  readonly snapshot: () => Pick<ConfigSnapshot, "doc">;
  readonly signInFor: (id: string) => ConnectorSignInKind;
  /** The active packs' suggestions, in order (`activePackSuggestedConnectors`). */
  readonly packSuggestions: readonly string[];
}): CatalogListResult {
  const visibility = resolveAgentVisibility(deps.snapshot(), CATALOG_AGENT_NAMES);
  const agents = listCatalogAgents().map((a) => ({
    ...a,
    visible: visibility.visible.has(a.name),
  }));

  const builtins: CatalogConnector[] = [];
  for (const id of builtinCatalogConnectorIds()) {
    const meta = META_BY_ID[id];
    if (meta !== undefined) {
      builtins.push({ kind: "builtin", id, ...meta, signIn: deps.signInFor(id) });
    }
  }
  builtins.sort(byId);

  const serviceByExtension = new Map(
    listRunGrants(deps.db).map((g) => [g.extension_id, g.service_id]),
  );
  const extensions: CatalogConnector[] = listExtensions(deps.db)
    .map(
      (row): CatalogConnector => ({
        kind: "extension",
        id: row.id,
        serviceId: serviceByExtension.get(row.id) ?? null,
        name: extensionName(row),
        category: "extension",
      }),
    )
    .sort(byId);

  const userMcp: CatalogConnector[] = listUserMcpConnectors(deps.db)
    .map(
      (r): CatalogConnector => ({
        kind: "user-mcp",
        id: r.service_id,
        name: r.service_id,
        category: "user-mcp",
      }),
    )
    .sort(byId);

  const offered = new Set<string>(builtins.map((c) => c.id));
  for (const c of extensions) {
    if (c.kind === "extension" && c.serviceId !== null) offered.add(c.serviceId);
  }
  const wanted =
    deps.packSuggestions.length > 0 ? deps.packSuggestions : NEUTRAL_SUGGESTED_CONNECTORS;

  return {
    agents,
    connectors: [...builtins, ...extensions, ...userMcp],
    suggestedConnectors: wanted.filter((id) => offered.has(id)),
    visibility: {
      basis: visibility.basis,
      packs: visibility.packs,
      notes: describeAgentVisibility(visibility),
    },
  };
}
