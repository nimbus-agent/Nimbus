import type { RegistryInfoResult, RegistryListResult, RegistrySearchResult } from "../../ipc/types";
import { isRecord } from "../incidents/safe";

/**
 * Shallow reply checks for the three renderer-callable registry reads. The gateway's own tests pin
 * the full shapes; here a reply of the wrong shape is dropped (`null`) rather than half-rendered.
 * Every string a registry wrote reaches the page through `safeText` as a React text node.
 */
export function asRegistryList(v: unknown): RegistryListResult | null {
  if (!isRecord(v) || !Array.isArray(v["registries"])) return null;
  return v["registries"].every((r) => isRecord(r) && typeof r["name"] === "string")
    ? (v as unknown as RegistryListResult)
    : null;
}

function isHit(h: unknown): boolean {
  return (
    isRecord(h) &&
    typeof h["registry"] === "string" &&
    typeof h["id"] === "string" &&
    typeof h["name"] === "string" &&
    typeof h["publisherId"] === "string" &&
    typeof h["blocked"] === "boolean"
  );
}

export function asRegistrySearch(v: unknown): RegistrySearchResult | null {
  if (!isRecord(v) || !Array.isArray(v["results"]) || !Array.isArray(v["errors"])) return null;
  return v["results"].every(isHit) ? (v as unknown as RegistrySearchResult) : null;
}

function isEvidence(e: unknown): boolean {
  return (
    isRecord(e) &&
    ["baseline", "tested", "history", "checked"].every(
      (k) => isRecord(e[k]) && typeof (e[k] as Record<string, unknown>)["text"] === "string",
    )
  );
}

export function asRegistryInfo(v: unknown): RegistryInfoResult | null {
  if (
    !isRecord(v) ||
    typeof v["registry"] !== "string" ||
    typeof v["id"] !== "string" ||
    typeof v["publisherId"] !== "string" ||
    !isEvidence(v["evidence"]) ||
    !isRecord(v["evidenceFor"]) ||
    !Array.isArray(v["versions"])
  )
    return null;
  const versionsOk = v["versions"].every(
    (x) => isRecord(x) && typeof x["version"] === "string" && typeof x["blocked"] === "boolean",
  );
  return versionsOk ? (v as unknown as RegistryInfoResult) : null;
}
