// packages/gateway/src/connectors/connector-writes/iac-plan-preview.ts
// The plan the owner approves before a Terraform apply, rendered by the GATEWAY from the parsed
// output of `terraform show -json` of the exact plan file it hashed (Phase 9.7 D2, spec § 15.5,
// invariant I54). PURE: it reads one parsed JSON value and a SHA-256 string and nothing else, so
// nothing the planning child printed can reach the prompt except through Terraform core's own
// rendering of the file's bytes. Input format: HashiCorp's documented JSON output
// (https://developer.hashicorp.com/terraform/internals/json-format).
//
// What is shown, in order: the counts (`Deletes`, `Replaces`, `Creates`, `Updates`), the Terraform
// version, the plan hash, the data-source reads, then one block per non-no-op resource change
// (address, type, provider, the actions, the `action_reason`, and for an update or replace the
// NAMES of the top-level attributes whose before and after differ, with a value only when it is a
// non-sensitive scalar of at most 120 characters), then the output changes (names and actions
// only), then the footer. A value marked sensitive prints `(sensitive)` on either side; one marked
// unknown prints `(known after apply)`. A plan over 500 changes (or 500 output changes), or whose
// text is over 64 KiB, is REFUSED, never truncated. Every string goes through `escapeDiffText`
// (injective: a literal backslash is doubled, so a typed `\u{202E}` cannot pass for a real one),
// with a newline escaped too so a name can never start a line of its own.
//
// Linear time: every value is visited a constant number of times (the sensitive and unknown
// markers once per side per attribute, the equality walk once per attribute), the depth of every
// walk is bounded (past it a marker counts as sensitive and a pair as different: fail closed), and
// the byte budget is checked as each line is added so a refusal comes early.

import { createHash } from "node:crypto";
import { IAC_LIMITS } from "./iac-limits.ts";
import {
  changedAttributes,
  escapeOneLine,
  isObj,
  markerOf,
  type Obj,
  own,
  showValue,
} from "./iac-plan-attrs.ts";

export { escapeOneLine };

/** Counts of the resource changes, by Terraform's own action classes. No-ops are not counted. */
export interface PlanPreviewCounts {
  readonly create: number;
  readonly update: number;
  readonly delete: number;
  /** `delete,create` or `create,delete`. */
  readonly replace: number;
  /** Data-source reads (not changes). */
  readonly read: number;
  /** Objects whose address moves in the state with no other change (`no-op` with `previous_address`). */
  readonly move: number;
}

/** Rendered text the gateway built: its lines, the joined text and the digest of that text. */
export interface RenderedText {
  readonly lines: readonly string[];
  /** `lines` joined by a newline. */
  readonly text: string;
  /** UTF-8 bytes of `text`. */
  readonly bytes: number;
  /** SHA-256 of `text`. */
  readonly sha256: string;
}

/** The rendered plan: structured lines, the joined text and its digest. */
export interface PlanPreview extends RenderedText {
  readonly terraformVersion: string;
  readonly counts: PlanPreviewCounts;
  /** Creates + updates + deletes + replaces (a replace counts once). */
  readonly changeCount: number;
  /** Deletes + replaces: every change that destroys something. */
  readonly deleteCount: number;
  /**
   * Objects Terraform reports as changed outside Terraform (`resource_drift`; a no-op only as a move):
   * `0` when it reports none, `null` when the field could not be read. Informational: it never
   * refuses a plan.
   */
  readonly driftCount: number | null;
  /** The drift block's own lines (escaped; names, never values), as spliced into `lines`. */
  readonly driftLines: readonly string[];
}

export type PlanPreviewOutcome =
  | { readonly ok: true; readonly preview: PlanPreview }
  | { readonly ok: false; readonly reason: "unshowable" | "tooLarge" };

export interface PlanPreviewLimits {
  readonly maxChanges: number;
  readonly maxRenderedBytes: number;
  readonly maxValueChars: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORMAT_VERSION = /^1\.\d+$/;

type Label = "create" | "update" | "delete" | "replace" | "read" | "no-op";
/** The classes an output change or a drifted object may have (no data-source read). */
const CHANGE_LABELS: readonly Label[] = ["no-op", "create", "update", "delete", "replace"];

class Refusal extends Error {
  readonly why: "unshowable" | "tooLarge";
  constructor(why: "unshowable" | "tooLarge") {
    super(why);
    this.why = why;
  }
}

/** The text, byte count and digest of `lines` (joined by a newline). */
export function renderedText(lines: readonly string[]): RenderedText {
  const text = lines.join("\n");
  return {
    lines,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/** The class of an `actions` list, or `undefined` when Terraform does not document it. */
function classify(actions: unknown, allowed: readonly Label[]): Label | undefined {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 2) return undefined;
  const list: unknown[] = actions;
  let label: Label | undefined;
  if (list.length === 1) {
    const a = list[0];
    if (a === "no-op" || a === "create" || a === "update" || a === "delete" || a === "read") {
      label = a;
    }
  } else if (
    (list[0] === "delete" && list[1] === "create") ||
    (list[0] === "create" && list[1] === "delete")
  ) {
    label = "replace";
  }
  return label !== undefined && allowed.includes(label) ? label : undefined;
}

/** Collects lines under a running byte budget; a line that would pass it refuses the plan. */
class Lines {
  readonly list: string[] = [];
  private bytes = 0;
  constructor(private readonly max: number) {}
  add(line: string): void {
    this.bytes += Buffer.byteLength(line, "utf8") + (this.list.length === 0 ? 0 : 1);
    if (this.bytes > this.max) throw new Refusal("tooLarge");
    this.list.push(line);
  }
}

function requireString(o: Obj, key: string): string {
  const v = own(o, key);
  if (typeof v !== "string") throw new Refusal("unshowable");
  return v;
}

interface ResourceChange {
  readonly label: Label;
  /** `previous_address` when it differs from `address`: the object moves in the state. */
  readonly movedFrom: string | undefined;
  readonly actions: readonly string[];
  readonly entry: Obj;
  readonly change: Obj;
}

function readResourceChanges(plan: Obj, maxChanges: number): ResourceChange[] {
  const raw = own(plan, "resource_changes");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Refusal("unshowable");
  const out: ResourceChange[] = [];
  for (const entry of raw as unknown[]) {
    if (!isObj(entry)) throw new Refusal("unshowable");
    const change = own(entry, "change");
    if (!isObj(change)) throw new Refusal("unshowable");
    const label = classify(own(change, "actions"), [...CHANGE_LABELS, "read"]);
    if (label === undefined) throw new Refusal("unshowable");
    // Validate every entry's strings, no-ops included: a plan the gateway cannot read whole is refused.
    requireString(entry, "address");
    requireString(entry, "type");
    requireString(entry, "provider_name");
    // Terraform's jsonplan sets `previous_address` on a moved object, a move-only one being a no-op:
    // applying it rewrites the state, so the owner must see it. A non-string value is unshowable.
    const prev = own(entry, "previous_address");
    if (prev !== undefined && typeof prev !== "string") throw new Refusal("unshowable");
    const movedFrom = prev !== undefined && prev !== own(entry, "address") ? prev : undefined;
    if (label === "no-op" && movedFrom === undefined) continue;
    if (out.length >= maxChanges) throw new Refusal("tooLarge");
    out.push({ label, movedFrom, actions: own(change, "actions") as string[], entry, change });
  }
  return out;
}

function readOutputChanges(plan: Obj, maxChanges: number): Array<{ name: string; label: Label }> {
  const raw = own(plan, "output_changes");
  if (raw === undefined) return [];
  if (!isObj(raw)) throw new Refusal("unshowable");
  const out: Array<{ name: string; label: Label }> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isObj(value)) throw new Refusal("unshowable");
    const label = classify(own(value, "actions"), CHANGE_LABELS);
    if (label === undefined) throw new Refusal("unshowable");
    if (label === "no-op") continue;
    if (out.length >= maxChanges) throw new Refusal("tooLarge");
    out.push({ name, label });
  }
  return out;
}

function tally(changes: readonly ResourceChange[]): PlanPreviewCounts {
  const counts = { create: 0, update: 0, delete: 0, replace: 0, read: 0, move: 0 };
  for (const c of changes) {
    if (c.label === "no-op") counts.move += 1;
    else counts[c.label] += 1;
  }
  return counts;
}

function actionText(rc: ResourceChange): string {
  return rc.label === "replace" ? `replace: ${rc.actions.join(", ")}` : rc.label;
}

function addChange(lines: Lines, rc: ResourceChange, maxValueChars: number): void {
  const address = escapeOneLine(requireString(rc.entry, "address"));
  const type = escapeOneLine(requireString(rc.entry, "type"));
  const provider = escapeOneLine(requireString(rc.entry, "provider_name"));
  if (rc.label === "no-op") {
    const from = escapeOneLine(rc.movedFrom ?? "");
    lines.add(`[moved in the state] ${from} -> ${address} (${type}, ${provider})`);
    return;
  }
  const moved = rc.movedFrom === undefined ? "" : ` (moved from ${escapeOneLine(rc.movedFrom)})`;
  lines.add(`[${actionText(rc)}] ${address} (${type}, ${provider})${moved}`);
  const reason = own(rc.entry, "action_reason");
  if (typeof reason === "string") lines.add(`    reason: ${escapeOneLine(reason)}`);
  if (rc.label !== "update" && rc.label !== "replace") return;
  const { change } = rc;
  const before = own(change, "before");
  const after = own(change, "after");
  for (const k of changedAttributes(change)) {
    const b = isObj(before) ? own(before, k) : undefined;
    const a = isObj(after) ? own(after, k) : undefined;
    const left = showValue(
      b,
      markerOf(own(change, "before_sensitive"), k),
      undefined,
      maxValueChars,
    );
    const right = showValue(
      a,
      markerOf(own(change, "after_sensitive"), k),
      markerOf(own(change, "after_unknown"), k),
      maxValueChars,
    );
    lines.add(`    ${escapeOneLine(k)}: ${left} -> ${right}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Drift: objects Terraform found changed outside Terraform when it refreshed (`resource_drift`).
//
// Informational only. The block is built after the plan and has its own byte budget, so a plan
// that rendered before this block existed renders now (never refused for its drift). Names only,
// never values: a drifted value may be a secret even where no sensitive marker says so.

/** The byte budget of the drift block, apart from the plan's own `maxRenderedBytes`. */
export const DRIFT_MAX_BYTES = 16_384;
/** More drifted objects than this are counted, not listed. */
export const DRIFT_MAX_LISTED = 100;

export const DRIFT_NONE_LINE = "Drift: none reported by terraform";
export const DRIFT_UNREADABLE_LINE = "Drift: could not be read from this plan (not shown)";

interface DriftBlock {
  readonly lines: readonly string[];
  readonly count: number | null;
}

interface DriftEntry {
  readonly label: Label;
  readonly entry: Obj;
  readonly change: Obj;
  /** `previous_address` when it differs from `address`: the object moves in the state. */
  readonly movedFrom: string | undefined;
}

/** The drift entries, or `null` when the field is present but not the documented shape. */
function readDrift(plan: Obj): DriftEntry[] | null {
  const raw = own(plan, "resource_drift");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: DriftEntry[] = [];
  for (const entry of raw as unknown[]) {
    if (!isObj(entry)) return null;
    const change = own(entry, "change");
    if (!isObj(change)) return null;
    const label = classify(own(change, "actions"), CHANGE_LABELS);
    if (label === undefined) return null;
    for (const key of ["address", "type", "provider_name"]) {
      if (typeof own(entry, key) !== "string") return null;
    }
    const prev = own(entry, "previous_address");
    if (prev !== undefined && typeof prev !== "string") return null;
    const movedFrom = prev !== undefined && prev !== own(entry, "address") ? prev : undefined;
    // An update compares two whole objects; anything else is not the documented shape.
    if (label === "update" && !(isObj(own(change, "before")) && isObj(own(change, "after")))) {
      return null;
    }
    // A refresh-only plan lists a move-only object as a no-op with `previous_address` (Terraform's
    // jsonplan): accepting the plan moves it in the state, so it is drift the owner must see.
    if (label !== "no-op" || movedFrom !== undefined) out.push({ label, entry, change, movedFrom });
  }
  return out;
}

function driftLabel(label: Label): string {
  if (label === "update") return "changed outside Terraform";
  if (label === "delete") return "deleted outside Terraform";
  return `${label} outside Terraform`;
}

/** The drift block: a summary line and, when it fits, every drifted object and attribute name. */
function buildDrift(plan: Obj): DriftBlock {
  const entries = readDrift(plan);
  if (entries === null) return { lines: [DRIFT_UNREADABLE_LINE], count: null };
  const n = entries.length;
  if (n === 0) return { lines: [DRIFT_NONE_LINE], count: 0 };
  const summary = `Drift: ${String(n)} objects changed outside Terraform (they differ from the last saved state)`;
  const tooMany: DriftBlock = { lines: [`${summary} (too many to list here)`], count: n };
  if (n > DRIFT_MAX_LISTED) return tooMany;
  const lines = new Lines(DRIFT_MAX_BYTES);
  try {
    lines.add(`${summary}:`);
    for (const d of entries) {
      const address = escapeOneLine(own(d.entry, "address") as string);
      const type = escapeOneLine(own(d.entry, "type") as string);
      const provider = escapeOneLine(own(d.entry, "provider_name") as string);
      const from = d.movedFrom === undefined ? undefined : escapeOneLine(d.movedFrom);
      // A move-only object (a no-op) names both addresses; a changed one that also moved, its old one.
      const moveOnly = d.label === "no-op";
      const head = moveOnly
        ? `[moved in the state] ${from} -> ${address}`
        : `[${driftLabel(d.label)}] ${address}`;
      const moved = !moveOnly && from !== undefined ? ` (moved from ${from})` : "";
      lines.add(`  ${head} (${type}, ${provider})${moved}`);
      if (d.label !== "update") continue;
      for (const k of changedAttributes(d.change)) lines.add(`    changed: ${escapeOneLine(k)}`);
    }
  } catch {
    return tooMany;
  }
  return { lines: lines.list, count: n };
}

function build(plan: Obj, planSha256: string, limits: PlanPreviewLimits): PlanPreview {
  const formatVersion = own(plan, "format_version");
  if (typeof formatVersion !== "string" || !FORMAT_VERSION.test(formatVersion)) {
    throw new Refusal("unshowable");
  }
  if (own(plan, "errored") === true || own(plan, "applyable") === false) {
    throw new Refusal("unshowable");
  }
  const version = escapeOneLine(requireString(plan, "terraform_version"));
  const changes = readResourceChanges(plan, limits.maxChanges);
  const outputs = readOutputChanges(plan, limits.maxChanges);
  const counts = tally(changes);
  const changeCount = counts.create + counts.update + counts.delete + counts.replace;
  const deleteCount = counts.delete + counts.replace;

  const lines = new Lines(limits.maxRenderedBytes);
  // Only a plan with moves names them, so a plan with none renders as before.
  const moves = counts.move > 0 ? `, Moves: ${String(counts.move)}` : "";
  lines.add(
    `Deletes: ${String(counts.delete)}, Replaces: ${String(counts.replace)}, Creates: ${String(counts.create)}, Updates: ${String(counts.update)}${moves}`,
  );
  lines.add(`Terraform ${version}`);
  lines.add(`Plan SHA-256: ${planSha256}`);
  lines.add(`Reads: ${String(counts.read)}`);
  const driftAt = lines.list.length;
  for (const rc of changes) addChange(lines, rc, limits.maxValueChars);
  if (outputs.length > 0) {
    lines.add("Outputs:");
    for (const o of outputs) lines.add(`  ${escapeOneLine(o.name)}: ${o.label}`);
  }
  // The header counts deletes and replaces apart; so does the footer (a replace is a delete AND a create).
  lines.add(
    `End of plan: ${String(changeCount)} changes (${String(counts.delete)} deletes, ${String(counts.replace)} replaces)${counts.move > 0 ? `, ${String(counts.move)} moves` : ""}`,
  );

  // The drift block goes after the reads line and before the first change. It is spliced in last
  // so it is outside the plan's byte budget (its own is DRIFT_MAX_BYTES).
  const drift = buildDrift(plan);
  const all = [...lines.list.slice(0, driftAt), ...drift.lines, ...lines.list.slice(driftAt)];
  const text = all.join("\n");
  return {
    terraformVersion: version,
    counts,
    changeCount,
    deleteCount,
    driftCount: drift.count,
    driftLines: drift.lines,
    lines: all,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * Renders the owner's view of a Terraform plan from `terraform show -json`'s parsed output.
 * `planSha256` is the gateway's own hash of the plan file (a lower-case hex string). A plan that
 * cannot be shown whole is refused: `unshowable` (not a documented 1.x plan, errored, not
 * applyable, an action or field the renderer does not know) or `tooLarge` (over the change or
 * byte cap). Never throws.
 */
export function renderPlanPreview(
  plan: unknown,
  planSha256: string,
  limits: Partial<PlanPreviewLimits> = {},
): PlanPreviewOutcome {
  if (!isObj(plan) || !SHA256_HEX.test(planSha256)) return { ok: false, reason: "unshowable" };
  const effective: PlanPreviewLimits = {
    maxChanges: limits.maxChanges ?? IAC_LIMITS.maxChanges,
    maxRenderedBytes: limits.maxRenderedBytes ?? IAC_LIMITS.maxRenderedBytes,
    maxValueChars: limits.maxValueChars ?? IAC_LIMITS.maxValueChars,
  };
  try {
    return { ok: true, preview: build(plan, planSha256, effective) };
  } catch (e) {
    // A Refusal is a documented refusal; anything else (a stack overflow on a hostile shape) is
    // unshowable too, never a throw into the gate.
    return { ok: false, reason: e instanceof Refusal ? e.why : "unshowable" };
  }
}
