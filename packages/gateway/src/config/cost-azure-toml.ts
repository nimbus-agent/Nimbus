/**
 * `[cost.azure]` - the Azure cost source (Phase 7, the Cost Pack, slice 12a; owner rulings 2026-11-28). Read by
 * `cost-toml.ts`, which refuses the whole cost config on any error here, as it does for every cost section.
 *
 * ```toml
 * [cost.azure]
 * export = { account = "acmecost", container = "exports", path = "focus/monthly" }
 * scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000"]
 * ```
 *
 * `export` names a FOCUS "cost and usage details" CSV export in Azure Blob Storage: `path` is the folder inside
 * the container that holds the date-range folders (the export's storage directory plus its name). `scopes` are
 * parsed and kept for the Query API fallback (slice 12b); the export path does not read them. Nothing is read
 * until `export` is set.
 */

export interface NimbusCostAzureConfig {
  /** Null: no export is configured. */
  readonly export: {
    readonly account: string;
    readonly container: string;
    readonly path: string;
  } | null;
  /** Cost Management scope resource ids (used by slice 12b only). */
  readonly scopes: readonly string[];
}

export const DEFAULT_COST_AZURE_CONFIG: NimbusCostAzureConfig = Object.freeze({
  export: null,
  scopes: Object.freeze([]),
});

export class CostAzureConfigError extends Error {}

/** Storage account names: 3 to 24 lowercase letters and digits. */
export const ACCOUNT_RE = /^[a-z0-9]{3,24}$/;
/** Container names: 3 to 63 characters, lowercase letters, digits and single hyphens, alphanumeric at both ends. */
export const CONTAINER_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/;
const SEGMENT_RE = /^[A-Za-z0-9!_.*'()=-]+$/;
export const COST_AZURE_MAX_PATH = 512;
export const COST_AZURE_MAX_SCOPES = 50;
const SCOPE_RE = /^\/[A-Za-z0-9/._()-]+$/;

const bad = (key: string, why: string): CostAzureConfigError =>
  new CostAzureConfigError(`[cost.azure].${key} ${why}`);

function readExport(v: unknown): NimbusCostAzureConfig["export"] {
  if (v === undefined) return null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw bad("export", '- use { account = "...", container = "...", path = "..." }');
  }
  const t = v as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (k !== "account" && k !== "container" && k !== "path") {
      throw bad("export", `has an unknown key "${k.slice(0, 40)}"`);
    }
  }
  const account = t["account"];
  const container = t["container"];
  const rawPath = t["path"];
  if (typeof account !== "string" || !ACCOUNT_RE.test(account)) {
    throw bad(
      "export.account",
      "must be a storage account name (3 to 24 lowercase letters and digits)",
    );
  }
  if (typeof container !== "string" || !CONTAINER_RE.test(container)) {
    throw bad("export.container", "must be a blob container name");
  }
  if (typeof rawPath !== "string") throw bad("export.path", "must be a string");
  const path = rawPath.replace(/^\/+|\/+$/g, "");
  const segments = path.split("/");
  if (
    path === "" ||
    path.length > COST_AZURE_MAX_PATH ||
    segments.some((s) => s === "." || s === ".." || !SEGMENT_RE.test(s))
  ) {
    throw bad("export.path", "must be the folder that holds the export's date-range folders");
  }
  return Object.freeze({ account, container, path });
}

function readScopes(v: unknown): readonly string[] {
  if (v === undefined) return Object.freeze([]);
  if (!Array.isArray(v) || v.length > COST_AZURE_MAX_SCOPES) {
    throw bad("scopes", `must be a list of at most ${String(COST_AZURE_MAX_SCOPES)} resource ids`);
  }
  const out: string[] = [];
  for (const s of v) {
    const scope = typeof s === "string" ? s.trim().replace(/\/+$/, "") : "";
    if (!SCOPE_RE.test(scope) || scope.length > COST_AZURE_MAX_PATH || scope.includes("..")) {
      throw bad("scopes", `has an invalid scope ${JSON.stringify(s)?.slice(0, 80)}`);
    }
    if (out.includes(scope)) throw bad("scopes", `lists ${scope} twice`);
    out.push(scope);
  }
  return Object.freeze(out);
}

export function readCostAzureTable(t: Record<string, unknown>): NimbusCostAzureConfig {
  for (const k of Object.keys(t)) {
    if (k !== "export" && k !== "scopes") {
      throw new CostAzureConfigError(`[cost.azure]: unknown key "${k}"`);
    }
  }
  return Object.freeze({ export: readExport(t["export"]), scopes: readScopes(t["scopes"]) });
}
