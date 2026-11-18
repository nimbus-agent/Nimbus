import type { IncidentRecordV1 } from "../incident/incident-record-types.ts";
import type { RunbookParam, RunbookParams } from "./runbook-types.ts";

/**
 * The typed interpolation of a runbook's parameters (Phase 10 IC6, spec § 5.6, invariant I57 (c)). Pure.
 *
 * The ONLY placeholders are these typed record fields; free text from a provider (a title, a description, a tag,
 * a chat message) has no placeholder, so an alert can never write a parameter. A value is also checked against a
 * strict character class at run time, so even a typed field that holds something unexpected cannot reach a tool.
 */
export const RUNBOOK_PLACEHOLDERS = [
  "service",
  "trigger.source",
  "trigger.provider_id",
  "opened_at",
  "opened_at_ms",
  "deploy.sha",
  "binding.argocd_app",
  "binding.deploy_environment",
] as const;

export type RunbookPlaceholder = (typeof RUNBOOK_PLACEHOLDERS)[number];

const PLACEHOLDER_SET: ReadonlySet<string> = new Set(RUNBOOK_PLACEHOLDERS);

/** `{name}`: a placeholder is braces around a lower-case dotted name. Any other brace text is refused at load. */
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** What an interpolated value may contain (after the typed lookup). */
export const RUNBOOK_VALUE_RE = /^[A-Za-z0-9._:/@+-]{1,256}$/;

/** The record's service bindings a runbook may name (config-declared, never provider text). */
export type RunbookBindings = {
  readonly argocdApps: readonly string[];
  readonly deployEnvironments: readonly string[];
};

/** Every placeholder name a string uses, and whether it has a stray brace. */
function placeholdersOf(text: string): { names: string[]; stray: boolean } {
  const names: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) names.push(m[1] ?? "");
  const rest = text.replace(PLACEHOLDER_RE, "");
  return { names, stray: rest.includes("{") || rest.includes("}") };
}

/** Load-time check: every placeholder in every string of `params` is a typed one. Returns the first problem. */
export function untypedPlaceholder(params: RunbookParams): string | null {
  const visit = (v: RunbookParam): string | null => {
    if (typeof v === "string") {
      const { names, stray } = placeholdersOf(v);
      if (stray) return "a parameter has an unmatched brace";
      for (const n of names) {
        if (!PLACEHOLDER_SET.has(n)) {
          return `{${n}} is not a typed record field (allowed: ${RUNBOOK_PLACEHOLDERS.join(", ")})`;
        }
      }
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v as readonly RunbookParam[]) {
        const p = visit(x);
        if (p !== null) return p;
      }
      return null;
    }
    if (typeof v === "object" && v !== null) {
      for (const x of Object.values(v as Record<string, RunbookParam>)) {
        const p = visit(x);
        if (p !== null) return p;
      }
    }
    return null;
  };
  return visit(params);
}

/** The one value a binding list gives, or a reason: exactly one must be configured. */
function single(list: readonly string[], what: string): string | { refused: string } {
  if (list.length === 1 && list[0] !== undefined) return list[0];
  return {
    refused:
      list.length === 0
        ? `the service declares no ${what}`
        : `the service declares ${String(list.length)} ${what}s, so {binding.*} is ambiguous`,
  };
}

/** The value of one typed placeholder for this record, or the reason it has none. */
export function placeholderValue(
  name: RunbookPlaceholder,
  record: IncidentRecordV1,
  bindings: RunbookBindings | undefined,
): string | { refused: string } {
  switch (name) {
    case "service":
      return record.binding.service ?? { refused: "the incident is not bound to a service" };
    case "trigger.source":
      return record.trigger.service;
    case "trigger.provider_id":
      return record.trigger.providerId;
    case "opened_at": {
      const ms = record.trigger.opened.ms;
      return ms === null ? { refused: "the incident has no open time" } : new Date(ms).toISOString();
    }
    case "opened_at_ms": {
      const ms = record.trigger.opened.ms;
      return ms === null ? { refused: "the incident has no open time" } : String(ms);
    }
    case "deploy.sha":
      return record.change.deployment?.sha ?? { refused: "the incident has no correlated deployment" };
    case "binding.argocd_app":
      return bindings === undefined
        ? { refused: "the service has no configuration" }
        : single(bindings.argocdApps, "Argo CD application");
    case "binding.deploy_environment":
      return bindings === undefined
        ? { refused: "the service has no configuration" }
        : single(bindings.deployEnvironments, "deploy environment");
  }
}

export type Interpolated =
  | { readonly ok: true; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Run-time interpolation: every placeholder is replaced by its typed value, each value checked against
 * {@link RUNBOOK_VALUE_RE}. A string that is exactly one placeholder becomes that value; a string with text around
 * it keeps the text (owner-authored) and substitutes the value. Any refusal refuses the whole step.
 */
export function interpolateParams(
  params: RunbookParams,
  record: IncidentRecordV1,
  bindings: RunbookBindings | undefined,
): Interpolated {
  const state: { refusal: string | null } = { refusal: null };
  const sub = (text: string): string =>
    text.replace(PLACEHOLDER_RE, (_all, raw: string) => {
      if (state.refusal !== null) return "";
      if (!PLACEHOLDER_SET.has(raw)) {
        state.refusal = `{${raw}} is not a typed record field`;
        return "";
      }
      const v = placeholderValue(raw as RunbookPlaceholder, record, bindings);
      if (typeof v !== "string") {
        state.refusal = `{${raw}}: ${v.refused}`;
        return "";
      }
      if (!RUNBOOK_VALUE_RE.test(v)) {
        state.refusal = `{${raw}} holds characters a runbook parameter may not carry`;
        return "";
      }
      return v;
    });
  const visit = (v: RunbookParam): unknown => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return (v as readonly RunbookParam[]).map(visit);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, RunbookParam>)) out[k] = visit(x);
      return out;
    }
    return v;
  };
  const out = visit(params) as Record<string, unknown>;
  if (state.refusal !== null) return { ok: false, reason: state.refusal };
  return { ok: true, params: out };
}
