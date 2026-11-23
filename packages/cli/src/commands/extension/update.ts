import type { IPCClient } from "../../ipc-client/index.ts";
import { registerConsentFor } from "../../lib/interactive-ipc-handlers.ts";
import {
  signatureLabel,
  type VerifiedPublisherCli,
  verifiedPublisherCell,
} from "../../lib/verified-publisher-text.ts";
import { stripControl } from "../captures-format.ts";
import { parseRequirementStatuses, requirementLines } from "../extension-requirements-format.ts";
import { hasFlag, stripFlags, takeFlagValue } from "./flags.ts";
import { type InstallWalkDeps, walkAfterInstall } from "./install.ts";

/**
 * ONE apply/read-only decision for `update` (`rest` excludes the `update` token): it applies only
 * with an id and without `--check`. No id lists updates and `--check` never applies.
 */
export function extensionUpdateApplies(rest: string[]): boolean {
  const id = stripFlags(rest).find((a) => !a.startsWith("--"));
  return id !== undefined && !hasFlag(rest, "--check");
}

export interface AvailableUpdateCli {
  readonly id: string;
  readonly displayName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly channel: "stable" | "beta";
  /** Whether the signature verified (NOT a verified publisher); rendered from `verificationStatus`. */
  readonly publisherStatus: "verified" | "unverified";
  readonly verificationStatus: "verified" | "signature_failed" | "publisher_key_conflict";
  /** The registry the extension was installed from — the only one its updates come from. */
  readonly sourceRegistry: string;
  /** R6, computed by the gateway when it served the list. Absent from an older gateway. */
  readonly verifiedPublisher?: VerifiedPublisherCli | null;
  /** The dependencies the update would install. Absent from an older gateway, or when not planned. */
  readonly addedPackages?: readonly { readonly id: string }[];
  /** Why the update does not fit, one line each. Absent from an older gateway. */
  readonly conflicts?: readonly { readonly reason?: string }[];
  /**
   * How the new version's registry-signed score compares with the installed one's, as the gateway
   * worded it. The CLI prints `text` and computes nothing; `--json` carries the whole object.
   * Absent from an older gateway.
   */
  readonly qualityChange?: { readonly text?: unknown };
}

export interface UpdateApplyResultCli {
  readonly applied: boolean;
  readonly reason?: string;
  readonly hint?: string;
  /** A failed update or downgrade whose rollback itself failed: what it left behind. Absent from an older gateway. */
  readonly detail?: string;
  readonly jobId?: string;
  /** The packages an applied update installed. Absent from an older gateway. */
  readonly addedPackages?: readonly {
    readonly id: string;
    readonly version: string;
    readonly registry: string | null;
    readonly kind?: string;
  }[];
  readonly connectorRequirements?: unknown;
  /** An applied update: the root had a run grant, now stale. */
  readonly grantDropped?: boolean;
  /** An applied update that made the root a starter pack (it cannot be approved). */
  readonly rootKind?: string;
  /**
   * An applied downgrade, or an update whose new version dropped a dependency: dependency-installed
   * packages left needed by nothing, dependents first.
   */
  readonly orphanedDependencies?: readonly string[];
}

export type AutoUpdateIpcCaller = (
  method: "extension.checkForUpdates" | "extension.update",
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface RunExtensionUpdateOpts {
  args: string[];
  caller: AutoUpdateIpcCaller;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  /** The post-install walk's wiring. Without it an update never walks (the commands are printed). */
  walk?: InstallWalkDeps;
}

/**
 * One update per line. The status column is about the SIGNATURE (`signature verified` /
 * `signature failed`), or `publisher key changed` when the key conflict stopped the check; a
 * verified publisher is a separate `✓ @handle` column. `--json` keeps the raw fields.
 */
function formatUpdateRow(u: AvailableUpdateCli): string {
  const status =
    u.verificationStatus === "publisher_key_conflict"
      ? "publisher key changed"
      : signatureLabel(u.verificationStatus);
  const mark = verifiedPublisherCell(u.verifiedPublisher);
  const verified = mark === "-" ? "" : `\t${mark}`;
  const added = (u.addedPackages ?? []).map((p) => stripControl(p.id));
  const adds = added.length === 0 ? "" : `\tadds ${added.join(", ")}`;
  const conflicts = (u.conflicts ?? [])
    .map((c) => `\tconflict: ${stripControl(c.reason ?? "conflict")}`)
    .join("");
  const quality =
    typeof u.qualityChange?.text === "string" ? `\t${stripControl(u.qualityChange.text)}` : "";
  return `${u.id}\t${u.fromVersion} → ${u.toVersion}\t[${u.channel}]\tfrom ${u.sourceRegistry}\t${status}${verified}${adds}${quality}${conflicts}`;
}

async function listExtensionUpdates(
  opts: RunExtensionUpdateOpts,
  isJson: boolean,
  isCheck: boolean,
  onlyId?: string,
): Promise<number> {
  const all = (await opts.caller("extension.checkForUpdates", {
    ...(isCheck ? { force: true } : {}),
  })) as AvailableUpdateCli[];
  const list = onlyId === undefined ? all : all.filter((u) => u.id === onlyId);
  if (isJson) {
    opts.writeStdout(`${JSON.stringify(list, undefined, 2)}\n`);
    return 0;
  }
  if (list.length === 0) {
    opts.writeStdout("No updates available.\n");
    return 0;
  }
  for (const u of list) opts.writeStdout(`${formatUpdateRow(u)}\n`);
  return 0;
}

async function applyExtensionUpdate(
  opts: RunExtensionUpdateOpts,
  id: string,
  toVersion: string | undefined,
  isJson: boolean,
  acceptPublisherKey?: string,
): Promise<number> {
  const list = (await opts.caller("extension.checkForUpdates", {})) as AvailableUpdateCli[];
  const entry = list.find((e) => e.id === id);
  if (entry === undefined) {
    opts.writeStderr(
      `no cached update for ${id} — run \`nimbus extension update --check\` first\n`,
    );
    return 1;
  }
  const targetVersion = toVersion ?? entry.toVersion;
  const res = (await opts.caller("extension.update", {
    id,
    toVersion: targetVersion,
    ...(acceptPublisherKey === undefined ? {} : { acceptPublisherKey }),
  })) as UpdateApplyResultCli;

  if (isJson) {
    opts.writeStdout(`${JSON.stringify(res, undefined, 2)}\n`);
    return res.applied ? 0 : 1;
  }
  if (res.applied) {
    const jobIdPart = res.jobId === undefined ? "" : ` (jobId=${res.jobId})`;
    opts.writeStdout(`updated ${id} to ${targetVersion}${jobIdPart}\n`);
    await reportAddedPackages(opts, res, id);
    // What the new version no longer declares, when nothing else needs it.
    reportKeptDependencies(opts.writeStderr, res, id);
    return 0;
  }
  // A hint may hold several lines (`update_conflicts` is one per conflict): each gets its own.
  const hintPart = (res.hint ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `\n  hint: ${line}`)
    .join("");
  opts.writeStderr(`update failed: ${res.reason ?? "unknown"}${hintPart}${detailPart(res)}\n`);
  return 1;
}

/** The `detail:` line of a failed update or downgrade (a rollback that left something behind); `""` without one. */
export function detailPart(res: UpdateApplyResultCli): string {
  return res.detail === undefined || res.detail === ""
    ? ""
    : `\n  detail: ${stripControl(res.detail)}`;
}

/**
 * What an applied update added: the `+` lines, the approve hint for the added CODE packages (a
 * starter-pack member has no code and is never offered), `Needs:`, then the attended walk.
 */
async function reportAddedPackages(
  opts: RunExtensionUpdateOpts,
  res: UpdateApplyResultCli,
  id: string,
): Promise<void> {
  const added = res.addedPackages ?? [];
  const lines: string[] = added.map(
    (d) =>
      `  + ${stripControl(d.id)}@${stripControl(d.version)} from registry ${stripControl(d.registry ?? "unknown")} (installed as a dependency)`,
  );
  const toApprove = added.filter((d) => d.kind !== "starter-pack").map((d) => stripControl(d.id));
  // The root's approval went stale with the update; a root that is now a pack cannot be approved.
  if (res.grantDropped === true && res.rootKind !== "starter-pack") {
    toApprove.push(stripControl(id));
  }
  if (toApprove.length > 0) {
    const cmds = toApprove.map((i) => `nimbus extension approve ${i}`).join(" && ");
    lines.push(`Nothing runs until you approve it: ${cmds}`);
  }
  const needs = parseRequirementStatuses(res.connectorRequirements);
  if (needs.length > 0) lines.push("Needs:", ...requirementLines(needs));
  if (lines.length > 0) opts.writeStdout(`${lines.join("\n")}\n`);
  if (toApprove.length > 0 || needs.length > 0) {
    await walkAfterInstall(opts.args, opts.walk, toApprove, needs, (line) =>
      opts.writeStdout(`${line}\n`),
    );
  }
}

/**
 * The `Kept …` line for the dependency-installed packages an applied update or downgrade left
 * needed by nothing (dependents first, so the commands run in order). None ⇒ nothing printed.
 */
export function reportKeptDependencies(
  writeStderr: (s: string) => void,
  res: UpdateApplyResultCli,
  id: string,
): void {
  const kept = (res.orphanedDependencies ?? []).map(stripControl);
  if (kept.length === 0) return;
  const removals = kept.map((k) => `nimbus extension remove ${k}`).join(" && ");
  writeStderr(
    `Kept ${kept.join(", ")}, no longer needed by ${stripControl(id)}; remove them with: ${removals}\n`,
  );
}

export async function runExtensionUpdateWithCaller(opts: RunExtensionUpdateOpts): Promise<number> {
  const args = opts.args;
  const isJson = hasFlag(args, "--json");
  const applies = extensionUpdateApplies(args);
  const isCheck = !applies;
  const toVersion = takeFlagValue(args, "--to");
  const id = stripFlags(args).find((a) => !a.startsWith("--"));

  if (id === undefined || !applies) {
    // No id, or `--check`, is strictly read-only: it never reaches `extension.update`.
    return listExtensionUpdates(opts, isJson, isCheck, id);
  }
  return applyExtensionUpdate(
    opts,
    id,
    toVersion,
    isJson,
    takeFlagValue(args, "--accept-publisher-key"),
  );
}

export async function runExtensionUpdate(
  client: IPCClient,
  args: string[],
  walk?: InstallWalkDeps,
): Promise<number> {
  // The gateway raises the owner's HITL prompt (`extension.update`) over this connection; `--check`
  // only reads, so it never prompts and registers nothing.
  if (extensionUpdateApplies(args.slice(1))) {
    registerConsentFor(client, { kind: "prompt" });
  }
  return runExtensionUpdateWithCaller({
    args: args.slice(1), // drop the "update" subcommand token
    caller: async (method, params) => client.call<unknown>(method, params),
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
    ...(walk === undefined ? {} : { walk }),
  });
}
