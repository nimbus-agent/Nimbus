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
import { escapeDiffText } from "./sanitise.ts";

/** Counts of the resource changes, by Terraform's own action classes. No-ops are not counted. */
export interface PlanPreviewCounts {
  readonly create: number;
  readonly update: number;
  readonly delete: number;
  /** `delete,create` or `create,delete`. */
  readonly replace: number;
  /** Data-source reads (not changes). */
  readonly read: number;
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
}

export type PlanPreviewOutcome =
  | { readonly ok: true; readonly preview: PlanPreview }
  | { readonly ok: false; readonly reason: "unshowable" | "tooLarge" };

export interface PlanPreviewLimits {
  readonly maxChanges: number;
  readonly maxRenderedBytes: number;
  readonly maxValueChars: number;
}

/** Nesting deeper than this is not walked: a marker counts as sensitive, a pair as different. */
const MAX_DEPTH = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORMAT_VERSION = /^1\.\d+$/;

type Obj = Record<string, unknown>;
type Label = "create" | "update" | "delete" | "replace" | "read" | "no-op";

class Refusal extends Error {
  readonly why: "unshowable" | "tooLarge";
  constructor(why: "unshowable" | "tooLarge") {
    super(why);
    this.why = why;
  }
}

function isObj(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
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

/** One line of text for a name: escaped injectively, newline included. */
export function escapeOneLine(s: string): string {
  return escapeDiffText(s).replaceAll("\n", String.raw`\u{000A}`);
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

/** Whether a sensitive / unknown marker marks anything: `true` anywhere inside it (deep). */
function marksAny(marker: unknown, depth = 0): boolean {
  if (marker === true) return true;
  if (depth >= MAX_DEPTH) return typeof marker === "object" && marker !== null;
  if (Array.isArray(marker)) return marker.some((m) => marksAny(m, depth + 1));
  if (typeof marker === "object" && marker !== null) {
    return Object.values(marker).some((m) => marksAny(m, depth + 1));
  }
  return false;
}

/** The marker of one attribute inside a marker container (`true` marks the whole container). */
function markerOf(container: unknown, key: string): unknown {
  if (container === true) return true;
  return isObj(container) ? own(container, key) : undefined;
}

function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i], depth + 1));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k], depth + 1))
    );
  }
  return false;
}

/** How one side of an attribute is shown. Never reveals a sensitive value or the content of a complex one. */
function showValue(
  value: unknown,
  sensitive: unknown,
  unknown_: unknown,
  maxValueChars: number,
): string {
  if (marksAny(sensitive)) return "(sensitive)";
  if (unknown_ === true) return "(known after apply)";
  if (marksAny(unknown_)) return "(partly known after apply)";
  if (value === undefined) return "(none)";
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.length > maxValueChars)
      return `(string of ${String(value.length)} characters, not shown)`;
    const escaped = escapeOneLine(value).replaceAll('"', String.raw`\"`);
    return `"${escaped}"`;
  }
  if (Array.isArray(value)) return `(list, ${String(value.length)} items)`;
  if (isObj(value)) return `(object, ${String(Object.keys(value).length)} keys)`;
  return "(value not shown)";
}

/** The names of the top-level attributes that differ between the two sides, in first-seen order. */
function changedAttributes(c: Obj): string[] {
  const before = own(c, "before");
  const after = own(c, "after");
  const unknownAfter = own(c, "after_unknown");
  const names = new Set<string>();
  for (const side of [before, after, unknownAfter]) {
    if (isObj(side)) for (const k of Object.keys(side)) names.add(k);
  }
  const out: string[] = [];
  for (const k of names) {
    const was = isObj(before) ? own(before, k) : undefined;
    const now = isObj(after) ? own(after, k) : undefined;
    const unk = markerOf(unknownAfter, k);
    if (!sameValue(was, now) || marksAny(unk)) out.push(k);
  }
  return out;
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
    const label = classify(own(change, "actions"), [
      "no-op",
      "create",
      "update",
      "delete",
      "replace",
      "read",
    ]);
    if (label === undefined) throw new Refusal("unshowable");
    // Validate every entry's strings, no-ops included: a plan the gateway cannot read whole is refused.
    requireString(entry, "address");
    requireString(entry, "type");
    requireString(entry, "provider_name");
    if (label === "no-op") continue;
    if (out.length >= maxChanges) throw new Refusal("tooLarge");
    out.push({ label, actions: own(change, "actions") as string[], entry, change });
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
    const label = classify(own(value, "actions"), [
      "no-op",
      "create",
      "update",
      "delete",
      "replace",
    ]);
    if (label === undefined) throw new Refusal("unshowable");
    if (label === "no-op") continue;
    if (out.length >= maxChanges) throw new Refusal("tooLarge");
    out.push({ name, label });
  }
  return out;
}

function tally(changes: readonly ResourceChange[]): PlanPreviewCounts {
  const counts = { create: 0, update: 0, delete: 0, replace: 0, read: 0 };
  for (const c of changes) {
    if (c.label !== "no-op") counts[c.label] += 1;
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
  lines.add(`[${actionText(rc)}] ${address} (${type}, ${provider})`);
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
  lines.add(
    `Deletes: ${String(counts.delete)}, Replaces: ${String(counts.replace)}, Creates: ${String(counts.create)}, Updates: ${String(counts.update)}`,
  );
  lines.add(`Terraform ${version}`);
  lines.add(`Plan SHA-256: ${planSha256}`);
  lines.add(`Reads: ${String(counts.read)}`);
  for (const rc of changes) addChange(lines, rc, limits.maxValueChars);
  if (outputs.length > 0) {
    lines.add("Outputs:");
    for (const o of outputs) lines.add(`  ${escapeOneLine(o.name)}: ${o.label}`);
  }
  // The header counts deletes and replaces apart; so does the footer (a replace is a delete AND a create).
  lines.add(
    `End of plan: ${String(changeCount)} changes (${String(counts.delete)} deletes, ${String(counts.replace)} replaces)`,
  );

  const text = lines.list.join("\n");
  return {
    terraformVersion: version,
    counts,
    changeCount,
    deleteCount,
    lines: lines.list,
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
