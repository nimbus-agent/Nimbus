// packages/gateway/src/automation/workflow-import-prompt.ts
// The exact text the LOCAL owner approves when importing a signed workflow bundle (I59, spec § 4.2).
// Pure: no I/O, no clock. Two rules make "what you approve is what is stored and run" hold:
//
//  - the steps section is a deterministic walk of the STORED canonical steps (the structure that is
//    written and hashed), with fields in a fixed order, so the owner reads every field the parser
//    accepted; and
//  - EVERY string the bundle supplied (name, author, description, a step label, a tool id, a service,
//    a column, an input field name, a `where` operand, a constant's string value AND every object key
//    inside a constant) goes through `escapeBundleText` and is the ONLY way such a string is printed
//    (a source test in the prompt test greps this module for any other path). A value can therefore
//    never begin a new prompt line, forge a `Signer:` row, close its own quotation or move the cursor.
//
// The derived lines (`What it can do`, the data flows) are computed from the parsed steps, never copied
// from the bundle, which has no free-text field except `description` and `author`, both shown escaped
// and labelled.
import { escapeDiffText } from "../connectors/connector-writes/sanitise.ts";
import { byCodeUnit } from "../util/canonical-json.ts";
import type { JsonValue, WorkflowGuard, WorkflowStep, WriteValue } from "./workflow-steps.ts";
import type { WriteToolInfo } from "./workflow-write-info.ts";

/** The prompt may be at most this long: a bundle too large to show is refused, never cut. */
export const IMPORT_PROMPT_MAX_BYTES = 64 * 1024;

export class ImportPromptTooLargeError extends Error {
  readonly code = "ERR_WORKFLOW_IMPORT_TOO_LARGE_TO_SHOW";
  constructor() {
    super("the workflow is too large to show for approval");
  }
}

/**
 * Bundle text made safe for a prompt line. `escapeDiffText` is INJECTIVE (it doubles a backslash) and
 * escapes every control, format (bidi, zero-width, tag block), line and paragraph separator, surrogate,
 * default-ignorable character and U+2800, but it keeps LF, so LF becomes the two characters `\n` here;
 * and the double quote becomes `\"` LAST (after the backslash doubling) so the result stays injective
 * and a quote cannot close the quotation it sits in.
 */
export function escapeBundleText(s: string): string {
  return escapeDiffText(s).replaceAll("\n", String.raw`\n`).replaceAll('"', String.raw`\"`);
}

/** A bundle string as a quoted, escaped token. */
function q(s: string): string {
  return `"${escapeBundleText(s)}"`;
}

/** A constant, walked (never re-serialised): strings and keys escaped, keys in canonical order. */
export function renderConst(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return q(v);
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${(v as readonly JsonValue[]).map(renderConst).join(", ")}]`;
  const rec = v as { readonly [key: string]: JsonValue };
  const keys = Object.keys(rec).sort(byCodeUnit);
  const members = keys.map((k) => `${q(k)}: ${renderConst(rec[k] as JsonValue)}`);
  return `{${members.join(", ")}}`;
}

function renderGuard(g: WorkflowGuard): string {
  return `count(${q(g.count)}) ${g.op} ${String(g.value)}`;
}

function renderWriteValue(v: WriteValue): string {
  if ("const" in v) return `const ${renderConst(v.const)}`;
  return `from ${q(v.from)} column ${q(v.column)}`;
}

function renderPredicate(p: Record<string, unknown>): string {
  if ("olderThanDays" in p) return `olderThanDays ${String(p["olderThanDays"])}`;
  if ("newerThanDays" in p) return `newerThanDays ${String(p["newerThanDays"])}`;
  const key = p["metadata"] as string;
  for (const op of ["contains", "notContains", "equals"] as const) {
    if (op in p) return `metadata ${q(key)} ${op} ${renderConst(p[op] as JsonValue)}`;
  }
  return "unknown predicate";
}

/** The verbatim steps section: one block per step, every accepted field, in a fixed order. */
export function renderStepsVerbatim(steps: readonly WorkflowStep[]): string[] {
  const out: string[] = [];
  steps.forEach((step, i) => {
    const n = `${String(i + 1)}.`;
    if (step.kind === "query") {
      const qy = step.query;
      const where = qy.where.map((p) => renderPredicate(p as Record<string, unknown>));
      out.push(
        `  ${n} query ${q(step.label)}`,
        `       service: ${q(qy.service)}  type: ${q(qy.type)}  select: ${q(qy.select)}  distinct: ${String(qy.distinct)}  limit: ${String(qy.limit)}`,
        `       where: [${where.join("; ")}]`,
      );
      return;
    }
    if (step.kind === "write") {
      const label = step.label === undefined ? "(no label)" : q(step.label);
      const when =
        step.when === undefined ? "none" : `[${step.when.map(renderGuard).join(" and ")}]`;
      out.push(
        `  ${n} write ${label}  tool: ${q(step.tool)}  continueOnError: ${String(step.continueOnError === true)}  when: ${when}`,
      );
      for (const field of Object.keys(step.input).sort(byCodeUnit)) {
        out.push(
          `       input.${escapeBundleText(field)}: ${renderWriteValue(step.input[field] as WriteValue)}`,
        );
      }
      return;
    }
    // A model step never reaches an import (refused by the bundle layer); shown, not hidden, if it did.
    out.push(`  ${n} MODEL STEP (not allowed in an import)`);
  });
  return out;
}

/** `What it can do`: derived from the parsed steps by Nimbus, never from the bundle's own words. */
export function renderCapabilities(
  steps: readonly WorkflowStep[],
  info: (toolId: string) => WriteToolInfo | undefined,
): string[] {
  const out: string[] = [
    "What it can do (read from the steps below, not from the bundle's own words):",
  ];
  const counts = new Map<string, number>();
  for (const s of steps) if (s.kind === "write") counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1);
  if (counts.size === 0) out.push("  Writes: none");
  for (const [tool, n] of counts) {
    const i = info(tool);
    const what = i === undefined ? "unknown tool" : `wave ${String(i.wave)}, ${i.actionType}`;
    out.push(`  Writes: ${q(tool)} (${what}) x${String(n)}`);
  }
  for (const s of steps) {
    if (s.kind !== "query") continue;
    const qy = s.query;
    out.push(
      `  Reads: ${q(qy.service)}/${q(qy.type)} select ${q(qy.select)} limit ${String(qy.limit)}`,
    );
  }
  const labels = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.kind === "query") labels.set(s.label, i + 1);
  });
  steps.forEach((s, i) => {
    if (s.kind !== "write") return;
    for (const field of Object.keys(s.input).sort(byCodeUnit)) {
      const v = s.input[field] as WriteValue;
      if ("from" in v) {
        const j = labels.get(v.from);
        out.push(
          `  Values from your index that flow into a write: step ${String(i + 1)} input.${escapeBundleText(field)} <- step ${j === undefined ? "?" : String(j)} (${q(v.column)})`,
        );
      }
    }
  });
  return out;
}

export interface ImportPromptInput {
  readonly name: string;
  readonly signerFingerprint: string;
  /** How often this signer's bundles were imported here (from the store, never the bundle). */
  readonly signerPrior: { readonly count: number; readonly lastAt: number } | null;
  readonly authorLabel: string | null;
  readonly issuedAt: number;
  readonly description: string | null;
  readonly target:
    | { readonly kind: "new" }
    | {
        readonly kind: "replace";
        readonly contentSha12: string;
        readonly updatedAt: number;
        readonly importedFromFp12: string | null;
        readonly identical: boolean;
        readonly schedule: { readonly expr: string; readonly tz: string } | null;
      };
  /** The name was last imported from another signer (the workflow exists): the capitals line. */
  readonly signerChange: { readonly fromFingerprint: string; readonly at: number } | null;
  /** The workflow was deleted; this signer imported the name before: an informational line. */
  readonly deletedPriorSigner: string | null;
  /** The bundle the floor row recorded is being re-imported: the date of that import. */
  readonly restoreOf: number | null;
  /** The owner-requested schedule (never from the bundle), with its first fire. */
  readonly schedule: { readonly expr: string; readonly tz: string; readonly nextAt: number } | null;
  readonly steps: readonly WorkflowStep[];
  readonly stepsSha256: string;
  readonly writeInfo: (toolId: string) => WriteToolInfo | undefined;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function targetLines(t: ImportPromptInput): string[] {
  const target = t.target;
  if (target.kind === "new") return ["This will: create a new workflow"];
  const from = target.importedFromFp12 === null ? "" : `, imported from ${target.importedFromFp12}`;
  const out = [
    `This will: REPLACE your workflow ${q(t.name)} (content ${target.contentSha12}, edited ${iso(target.updatedAt)}${from})`,
  ];
  if (t.signerChange !== null) {
    out.push(
      `           SIGNER CHANGED: ${q(t.name)} WAS IMPORTED FROM ${t.signerChange.fromFingerprint} ON ${iso(t.signerChange.at)}; THIS BUNDLE IS SIGNED BY ${t.signerFingerprint}`,
    );
  }
  if (target.schedule !== null) {
    out.push(
      t.schedule === null
        ? `           Its schedule (${q(target.schedule.expr)} in ${q(target.schedule.tz)}) is cleared.`
        : "           Its schedule is replaced by the one you asked for.",
    );
  }
  if (target.identical) out.push("           Content is identical to your current workflow.");
  return out;
}

function headerLines(i: ImportPromptInput): string[] {
  const history =
    i.signerPrior === null
      ? "first import from this signer"
      : `imported ${String(i.signerPrior.count)} times, last ${iso(i.signerPrior.lastAt)}`;
  const lines = [
    `Import the workflow ${q(i.name)} from a signed bundle`,
    `Signer: ${i.signerFingerprint}   (${history})`,
    "        Nimbus cannot tell you who holds this key. Compare the fingerprint with the author out of band.",
    `Author label (UNVERIFIED, written by the bundle): ${i.authorLabel === null ? "none" : q(i.authorLabel)}`,
    `Issued: ${iso(i.issuedAt)} (the exporter's clock, not verified)`,
    `Description: ${i.description === null ? "none" : q(i.description)}`,
  ];
  if (i.deletedPriorSigner !== null) {
    lines.push(
      `A workflow named ${q(i.name)} was imported from ${i.deletedPriorSigner} before you deleted it.`,
    );
  }
  if (i.restoreOf !== null) lines.push(`Restores the bundle you imported on ${iso(i.restoreOf)}`);
  return lines;
}

/** The whole approval text. Throws {@link ImportPromptTooLargeError} past 64 KiB (never truncates). */
export function renderImportPrompt(i: ImportPromptInput): string {
  const queries = i.steps.filter((s) => s.kind === "query").length;
  const writes = i.steps.filter((s) => s.kind === "write").length;
  const schedule =
    i.schedule === null
      ? "none   (a bundle cannot carry one)"
      : `you asked for ${q(i.schedule.expr)} in ${q(i.schedule.tz)}: next run ${iso(i.schedule.nextAt)}   (a bundle cannot carry one)`;
  const lines = [
    ...headerLines(i),
    ...targetLines(i),
    `Schedule: ${schedule}`,
    `Steps: ${String(i.steps.length)} (${String(queries)} query, ${String(writes)} write). No model steps.`,
    `Content hash: ${i.stepsSha256}   (the hash standing rules and run history use for this exact text)`,
    ...renderCapabilities(i.steps, i.writeInfo),
    "Steps, verbatim:",
    ...renderStepsVerbatim(i.steps),
    "After import it runs only when you start it, or on a schedule you set. Every write still asks you, with",
    "its own preview, unless a standing rule that you create separately covers it. This import creates no",
    "standing rule and inherits none.",
  ];
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > IMPORT_PROMPT_MAX_BYTES)
    throw new ImportPromptTooLargeError();
  return text;
}
