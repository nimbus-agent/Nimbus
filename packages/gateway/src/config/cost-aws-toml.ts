/**
 * `[cost.aws]` - the AWS cost source (Phase 7, the Cost Pack, slice 11a; owner rulings 2026-11-28). Read by
 * `cost-toml.ts`, which refuses the whole cost config on any error here, as it does for every cost section.
 *
 * ```toml
 * [cost.aws]
 * export = "s3://my-cost-bucket/focus"   # a FOCUS 1.0 CSV Data Export; the prefix holds ONE export
 * cost_explorer = false                  # opt-in fallback (slice 11b), USD 0.01 per request; used only with no export
 * ```
 *
 * Nothing is read until `export` (or, from slice 11b, `cost_explorer`) is set.
 */

export interface NimbusCostAwsConfig {
  /** Null: no export is configured. */
  readonly export: { readonly bucket: string; readonly prefix: string } | null;
  readonly costExplorer: boolean;
}

export const DEFAULT_COST_AWS_CONFIG: NimbusCostAwsConfig = Object.freeze({
  export: null,
  costExplorer: false,
});

export class CostAwsConfigError extends Error {}

/** S3 bucket naming rules: 3 to 63 characters, lowercase letters, digits, hyphens and dots, not an IP address. */
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A key prefix: the characters S3 documents as safe, no leading slash, no empty or dot segment. */
const PREFIX_RE = /^[A-Za-z0-9!_.*'()=-]+(?:\/[A-Za-z0-9!_.*'()=-]+)*$/;
export const COST_AWS_MAX_PREFIX = 512;

/** `s3://bucket` or `s3://bucket/prefix` as a bucket and a prefix without a trailing slash ("" for none). */
export function parseS3ExportUrl(v: unknown): { bucket: string; prefix: string } {
  const shown = JSON.stringify(v)?.slice(0, 80) ?? "undefined";
  const bad = (why: string): CostAwsConfigError =>
    new CostAwsConfigError(`[cost.aws].export: ${shown} ${why}; use "s3://bucket/prefix"`);
  if (typeof v !== "string") throw bad("is not a string");
  if (!v.startsWith("s3://")) throw bad("is not an s3:// URL");
  const rest = v.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = (slash === -1 ? "" : rest.slice(slash + 1)).replace(/\/+$/, "");
  if (!BUCKET_RE.test(bucket) || bucket.includes("..") || IPV4_RE.test(bucket)) {
    throw bad("does not name a valid S3 bucket");
  }
  if (prefix !== "") {
    if (prefix.length > COST_AWS_MAX_PREFIX) throw bad("has a prefix that is too long");
    if (!PREFIX_RE.test(prefix) || prefix.split("/").some((s) => s === "." || s === "..")) {
      throw bad("has an invalid prefix");
    }
  }
  return { bucket, prefix };
}

export function readCostAwsTable(t: Record<string, unknown>): NimbusCostAwsConfig {
  for (const k of Object.keys(t)) {
    if (k !== "export" && k !== "cost_explorer") {
      throw new CostAwsConfigError(`[cost.aws]: unknown key "${k}"`);
    }
  }
  const ce = t["cost_explorer"];
  if (ce !== undefined && typeof ce !== "boolean") {
    throw new CostAwsConfigError("[cost.aws].cost_explorer must be true or false");
  }
  return Object.freeze({
    export: t["export"] === undefined ? null : Object.freeze(parseS3ExportUrl(t["export"])),
    costExplorer: ce === true,
  });
}
