/**
 * The ONE validator of the gateway's `__nimbus-eval` role document: the CLI renders it and the
 * registry action scores from it, so both read it through this module. The role writes exactly
 * one JSON document to stdout; anything that is not one of the two shapes below is `null`.
 * Pure: no Bun, no gateway imports.
 */
import { parseEvalQuality } from "./eval-quality.ts";
import { isObject, parseEvalRoleEnvelope } from "./eval-role-envelope.ts";
import type { EvalReport } from "./eval-score.ts";

export type EvalRoleDocument =
  | { ok: true; extensionId: string; version: string; report: EvalReport }
  | { ok: false; error: { code: string; message: string } };

function isResult(v: unknown): boolean {
  return (
    isObject(v) &&
    typeof v["suite"] === "string" &&
    typeof v["case"] === "string" &&
    typeof v["rubric"] === "string" &&
    typeof v["pass"] === "boolean" &&
    (v["reason"] === null || typeof v["reason"] === "string")
  );
}

/**
 * A report whose quality fields are `parseEvalQuality`-valid and whose `results` agree with them
 * (one result per case, as many passing as `passed`); null otherwise.
 */
export function parseEvalReport(raw: unknown): EvalReport | null {
  if (!isObject(raw) || !Array.isArray(raw["results"])) return null;
  if (!raw["results"].every(isResult)) return null;
  const { results: _results, ...quality } = raw;
  try {
    parseEvalQuality(quality);
  } catch {
    return null;
  }
  const results = raw["results"] as Record<string, unknown>[];
  if (results.length !== raw["cases"]) return null;
  if (results.filter((r) => r["pass"] === true).length !== raw["passed"]) return null;
  return raw as unknown as EvalReport;
}

/** Validate the role's document; null when it is not one. */
export function parseEvalRoleDocument(text: string): EvalRoleDocument | null {
  const envelope = parseEvalRoleEnvelope(text);
  if (envelope === null) return null;
  if (envelope.kind === "error") return { ok: false, error: envelope.error };
  const report = parseEvalReport(envelope.raw["report"]);
  if (report === null) return null;
  return { ok: true, extensionId: envelope.extensionId, version: envelope.version, report };
}
