/**
 * The text the local owner approves for an install that adds more than one package (a dependency
 * plan). Pure: it formats what it is handed and reads nothing. The rendered plan is the prompt body
 * (`executor.ts` prints it after the Details line), so every manifest-sourced string is passed
 * through `oneLine` first: a control, line-break, invisible or bidi character is shown as an escape,
 * never rendered, and cannot forge a line of the prompt.
 */
import { FORMAT_INVISIBLE_RANGES } from "../mcp-sink/invisible-text.ts";
import type { ExtensionManifest } from "./manifest.ts";

/**
 * One package of an install plan, as the owner is shown it. Field names never contain "key" or
 * "auth": the consent display redacts any such field (`executor.ts` `SENSITIVE_PAYLOAD_KEY`).
 */
export type PlannedPackage = {
  readonly id: string;
  readonly version: string;
  /** Every edge that selected it, in plan order: `[{ from: "com.example.tool", range: "^1.0.0" }]`; empty for the root. */
  readonly requiredBy: readonly { readonly from: string; readonly range: string }[];
  /** Registry NAME; null for a local root or a local copy. */
  readonly registry: string | null;
  readonly registryUrl: string | null;
  readonly publisher: { readonly id: string; readonly fingerprint: string } | null;
  /** Set only for a VERIFIED publisher (R6): the one sentence to show. */
  readonly publisherBadge?: string;
  /** As the root request's `publisherChange` / `publisherChangeNote` (fingerprints only). */
  readonly publisherChange?: {
    readonly from: readonly string[];
    readonly to: string;
    readonly via: string;
  };
  readonly publisherChangeNote?: string;
  readonly permissions: ExtensionManifest["permissions"];
  readonly newlyInstalled: boolean;
};

type Permissions = ExtensionManifest["permissions"];

function isHidden(cp: number): boolean {
  if (cp < 0x20) return true;
  return FORMAT_INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function escapeCodePoint(cp: number): string {
  const hex = cp.toString(16).toUpperCase();
  return cp > 0xffff ? String.raw`\u{${hex}}` : String.raw`\u${hex.padStart(4, "0")}`;
}

/** Every C0 control (line breaks and tabs included), DEL, C1 and format-invisible character, escaped. */
function oneLine(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isHidden(cp) ? escapeCodePoint(cp) : ch;
  }
  return out;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(oneLine).join(", ");
}

function permissionsLine(p: Permissions): string {
  return `network: ${listOrNone(p.network)} · read: ${listOrNone(p.filesystem.read)} · write: ${listOrNone(p.filesystem.write)}`;
}

/** Code-unit order: the same on every machine, whatever its locale. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodeUnit);
}

/** The permissions every NEWLY installed package of `plan` declares together, sorted and deduplicated. */
export function planPermissionsUnion(plan: readonly PlannedPackage[]): Permissions {
  const added = plan.filter((p) => p.newlyInstalled);
  return {
    network: sortedUnique(added.flatMap((p) => p.permissions.network)),
    filesystem: {
      read: sortedUnique(added.flatMap((p) => p.permissions.filesystem.read)),
      write: sortedUnique(added.flatMap((p) => p.permissions.filesystem.write)),
    },
  };
}

function registryText(p: PlannedPackage): string {
  if (p.registry === null) return "a local folder";
  const url = p.registryUrl === null ? "" : ` (${oneLine(p.registryUrl)})`;
  return `registry ${oneLine(p.registry)}${url}`;
}

function publisherText(p: PlannedPackage): string {
  if (p.publisher === null) return "unsigned";
  // 16 characters, as the CLI's `shortKey` shows a publisher key: 4 is too few to compare by eye.
  const fp = `${oneLine(p.publisher.fingerprint.slice(0, 16))}…`;
  const verified = p.publisherBadge === undefined ? "unverified" : "verified";
  return `publisher ${oneLine(p.publisher.id)} (${fp}), ${verified}`;
}

function requiredByText(p: PlannedPackage): string {
  if (p.requiredBy.length === 0) return "";
  return ` (${p.requiredBy.map((e) => `${oneLine(e.from)} needs ${oneLine(e.range)}`).join("; ")})`;
}

function packageBlock(p: PlannedPackage): string[] {
  const lines = [
    `  ${oneLine(p.id)}@${oneLine(p.version)}${requiredByText(p)} — ${registryText(p)} — ${publisherText(p)}`,
  ];
  if (p.publisherChangeNote !== undefined) lines.push(`    ${oneLine(p.publisherChangeNote)}`);
  lines.push(`    ${permissionsLine(p.permissions)}`);
  return lines;
}

function reusedText(p: PlannedPackage): string {
  const from = p.registry === null ? "a local folder" : `registry ${oneLine(p.registry)}`;
  return `${oneLine(p.id)}@${oneLine(p.version)} (${from})`;
}

/**
 * One block per newly installed package (plan order), then the packages reused as installed, then
 * the permissions of every added package together (`union`, see {@link planPermissionsUnion}).
 */
export function renderInstallPlan(plan: readonly PlannedPackage[], union: Permissions): string {
  const added = plan.filter((p) => p.newlyInstalled);
  const reused = plan.filter((p) => !p.newlyInstalled);
  const lines = [
    `This install adds ${added.length} ${added.length === 1 ? "package" : "packages"}:`,
    ...added.flatMap(packageBlock),
  ];
  if (reused.length > 0) {
    lines.push(`Already installed and reused: ${reused.map(reusedText).join(", ")}`);
  }
  lines.push(`All packages together: ${permissionsLine(union)}`);
  return lines.join("\n");
}
