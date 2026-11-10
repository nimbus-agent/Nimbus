import type { CatalogAgent, CatalogParam } from "../ipc/types";

/** The desktop never names which peers' namespaces to ask (spec § 5.5). */
export const FEDERATION_PARAMS: ReadonlySet<string> = new Set(["namespace", "namespaces"]);

/** Agents that fan out to paired peers on their own, so their form says so before Run. */
export const FEDERATED_AGENTS: ReadonlySet<string> = new Set(["huddle", "ghost"]);

export const CATEGORY_ORDER = ["catch-up", "knowledge", "people", "code", "operations"] as const;

/**
 * 90 days is the gateway's `MAX_SINCE_MS` for every agent but `negotiate` (365). "Default" omits the
 * param so each agent keeps its own default.
 */
export const SINCE_PRESETS = [
  { label: "Default", ms: undefined },
  { label: "24 hours", ms: 86_400_000 },
  { label: "7 days", ms: 604_800_000 },
  { label: "30 days", ms: 2_592_000_000 },
  { label: "90 days", ms: 7_776_000_000 },
  { label: "1 year", ms: 31_536_000_000 },
] as const;

/**
 * Initial form values from a URL query string (`/briefs/decisions?sinceMs=…`, used by onboarding's
 * "Widen the window"): only a non-boolean param the brief declares, and for `sinceMs` only one of
 * {@link SINCE_PRESETS}. A prefill never runs the brief; the owner still clicks Run.
 */
export function prefillValues(params: readonly CatalogParam[], query: URLSearchParams): FormValues {
  const presets: ReadonlySet<string> = new Set(
    SINCE_PRESETS.flatMap((s) => (s.ms === undefined ? [] : [String(s.ms)])),
  );
  const out: Record<string, string> = {};
  for (const p of params) {
    const v = query.get(p.name);
    if (v === null || p.kind === "boolean") continue;
    if (p.name === "sinceMs" && !presets.has(v)) continue;
    out[p.name] = v;
  }
  return out;
}

export type FormModel = {
  plain: readonly CatalogParam[];
  groups: readonly {
    group: string;
    required: boolean;
    arms: readonly { arm: string; fields: readonly CatalogParam[] }[];
  }[];
};

export type FormValues = Readonly<Record<string, string | boolean>>;

export function buildFormModel(params: readonly CatalogParam[]): FormModel {
  const plain: CatalogParam[] = [];
  const groups: {
    group: string;
    required: boolean;
    arms: { arm: string; fields: CatalogParam[] }[];
  }[] = [];
  for (const p of params) {
    if (FEDERATION_PARAMS.has(p.name)) continue;
    const o = p.oneOf;
    if (o === undefined) {
      plain.push(p);
      continue;
    }
    let g = groups.find((x) => x.group === o.group);
    if (g === undefined) {
      g = { group: o.group, required: o.required, arms: [] };
      groups.push(g);
    }
    let a = g.arms.find((x) => x.arm === o.arm);
    if (a === undefined) {
      a = { arm: o.arm, fields: [] };
      g.arms.push(a);
    }
    a.fields.push(p);
  }
  return { plain, groups };
}

export function hasRequiredParams(agent: CatalogAgent): boolean {
  const model = buildFormModel(agent.params);
  return model.plain.some((p) => p.required) || model.groups.some((g) => g.required);
}

type FieldRead = { value: unknown } | { problem: string } | undefined;

function readNumberField(p: CatalogParam, v: FormValues[string] | undefined): FieldRead {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "" || (p.name === "sinceMs" && s === "Default")) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? { value: n } : { problem: `${p.label} must be a number` };
}

function readStringArrayField(v: FormValues[string] | undefined): FieldRead {
  if (typeof v !== "string") return undefined;
  const items = v
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return items.length > 0 ? { value: items } : undefined;
}

function readTextField(v: FormValues[string] | undefined): FieldRead {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : { value: s };
}

function readField(p: CatalogParam, v: FormValues[string] | undefined): FieldRead {
  switch (p.kind) {
    case "boolean":
      return v === true ? { value: true } : undefined;
    case "number":
      return readNumberField(p, v);
    case "stringArray":
      return readStringArrayField(v);
    default:
      return readTextField(v);
  }
}

/** `undefined` means "omit". A value the field cannot hold is reported through `problems`. */
function collectOne(
  p: CatalogParam,
  values: FormValues,
  required: boolean,
  params: Record<string, unknown>,
  problems: string[],
): void {
  const read = readField(p, values[p.name]);
  if (read === undefined) {
    if (required) problems.push(`${p.label} is required`);
    return;
  }
  if ("problem" in read) {
    problems.push(read.problem);
    return;
  }
  params[p.name] = read.value;
}

export function collectParams(
  model: FormModel,
  values: FormValues,
  arms: Readonly<Record<string, string>>,
): { ok: true; params: Record<string, unknown> } | { ok: false; problems: readonly string[] } {
  const params: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const p of model.plain) collectOne(p, values, p.required, params, problems);
  for (const g of model.groups) {
    const chosen = g.arms.find((a) => a.arm === arms[g.group]);
    if (chosen === undefined) {
      if (g.required) problems.push(`Choose one of: ${g.arms.map((a) => a.arm).join(", ")}`);
      continue;
    }
    for (const f of chosen.fields) {
      collectOne(f, values, f.oneOf?.armRequired === true, params, problems);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, params };
}
