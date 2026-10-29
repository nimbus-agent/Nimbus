/**
 * The walk after an ATTENDED `nimbus extension install`: approve each newly installed package to
 * run, then offer to connect each connector it still needs.
 *
 * The walk is OFFERED: one question first ("Approve … to run now?"); a no skips every approval. The
 * walk never approves anything itself. On a yes, every approval is the existing `extension approve`
 * command, whose `extension.run` consent prompt is answered by the person at the terminal, so the
 * owner is asked once per package — that prompt IS the decision. The walk only runs when the
 * install was attended (stdin and stdout are terminals and there was no `--yes`); unattended, the
 * printed commands stand on their own. Nothing here can make the install fail: a declined approval
 * or a failed connect is logged and the walk moves on; an approval that could not be ASKED (not a
 * denial) is logged and stops the walk.
 */
import { stripControl } from "./captures-format.ts";
import type { RequirementStatusView } from "./extension-requirements-format.ts";

export type PostInstallIo = {
  /** stdin AND stdout are TTY, and the install was not given --yes. */
  readonly attended: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  /** `runExtensionApprove` on a FRESH client. */
  readonly approve: (extensionId: string) => Promise<void>;
  readonly connect: (
    req: RequirementStatusView,
    alreadyApproved: ReadonlySet<string>,
  ) => Promise<void>;
  readonly log: (line: string) => void;
};

function messageOf(e: unknown): string {
  return stripControl(e instanceof Error ? e.message : String(e));
}

/**
 * The gateway's refusal code when the owner answers no to an `extension.run` prompt (or lets it
 * time out). It leads the error message (`ExtensionRunGrantError`), which is all a client sees; the
 * CLI does not import gateway source, so it matches the code by text.
 */
export const RUN_NOT_APPROVED_CODE = "ERR_EXTENSION_RUN_NOT_APPROVED";

function isApprovalDenied(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).includes(RUN_NOT_APPROVED_CODE);
}

function approveNowQuestion(toApprove: readonly string[]): string {
  const [only] = toApprove;
  return toApprove.length === 1 && only !== undefined
    ? `Approve ${stripControl(only)} to run now? [y/N] `
    : `Approve the ${toApprove.length} new packages to run now? [y/N] `;
}

/**
 * The approvals phase: one up-front question, then (on a yes) each package's own `extension.run`
 * prompt. Returns `false` when the walk must stop: a prompt could not be asked at all (the gateway
 * went away, say), which is not the owner declining.
 */
async function approvalsPhase(
  io: PostInstallIo,
  toApprove: readonly string[],
  approved: Set<string>,
  declined: Set<string>,
): Promise<boolean> {
  if (toApprove.length === 0) return true;
  let walk: boolean;
  try {
    walk = await io.confirm(approveNowQuestion(toApprove));
  } catch (e) {
    io.log(`Could not ask (${messageOf(e)}); approve later with: ${approveCommands(toApprove)}`);
    return false;
  }
  if (!walk) {
    for (const id of toApprove) declined.add(id);
    io.log(`Not approved now; approve later with: ${approveCommands(toApprove)}`);
    return true;
  }
  io.log("Approve each package to run (you can decline any):");
  for (const [i, id] of toApprove.entries()) {
    try {
      await io.approve(id);
      approved.add(id);
    } catch (e) {
      if (!isApprovalDenied(e)) {
        io.log(`  ${stripControl(id)}: could not ask (${messageOf(e)})`);
        io.log(`Approve later with: ${approveCommands(toApprove.slice(i))}`);
        return false;
      }
      declined.add(id);
      io.log(`  ${stripControl(id)}: not approved`);
    }
  }
  return true;
}

function approveCommands(ids: readonly string[]): string {
  return ids.map((id) => `nimbus extension approve ${stripControl(id)}`).join(" && ");
}

export async function runPostInstallWalk(
  io: PostInstallIo,
  toApprove: readonly string[],
  requirements: readonly RequirementStatusView[],
): Promise<void> {
  if (!io.attended) return;
  // Approvals first: a continuity owner's credential set needs its run grant.
  const approved = new Set<string>();
  const declined = new Set<string>();
  if (!(await approvalsPhase(io, toApprove, approved, declined))) return;
  for (const req of requirements) {
    if (req.state !== "not_connected") continue;
    const connector = stripControl(req.connector);
    if (!req.interactive) {
      io.log(`  ${connector}: connect it with: ${req.fix.map(stripControl).join(" && ")}`);
      continue;
    }
    // Nothing that needs this connector will run: asking to connect it now only adds prompts.
    if (req.requiredBy.length > 0 && req.requiredBy.every((id) => declined.has(id))) {
      io.log(
        `  ${connector}: skipped — ${req.requiredBy.map(stripControl).join(", ")} not approved`,
      );
      continue;
    }
    // A fix that would approve a package the owner just declined would raise the same prompt
    // again; say so once instead of asking.
    const refused = declinedApprovalIn(req, declined);
    if (refused !== undefined) {
      io.log(`  ${connector}: skipped — ${stripControl(refused)} was not approved`);
      continue;
    }
    try {
      if (await io.confirm(`This needs ${connector}. Connect now? [y/N] `)) {
        await io.connect(req, approved);
      }
    } catch (e) {
      io.log(`  ${connector}: not connected (${messageOf(e)})`);
    }
  }
}

/** The first package a requirement's fix would approve that the owner declined, if any. */
function declinedApprovalIn(
  req: RequirementStatusView,
  declined: ReadonlySet<string>,
): string | undefined {
  for (const command of req.fix) {
    const parsed = parseFixCommand(command);
    if (parsed?.kind === "approve" && declined.has(parsed.extensionId)) return parsed.extensionId;
  }
  return undefined;
}

/** One fix command, parsed from its fixed prefix. Never handed to a shell. */
export type FixCommand =
  | { readonly kind: "connector-auth"; readonly id: string }
  | { readonly kind: "approve"; readonly extensionId: string }
  | { readonly kind: "credential-set"; readonly extensionId: string; readonly name: string };

/** Parses the three fix commands the gateway emits; anything else is `undefined`. */
export function parseFixCommand(command: string): FixCommand | undefined {
  const t = command.trim().split(/\s+/);
  if (t[0] !== "nimbus") return undefined;
  const [, a, b, c, d, e] = t;
  if (t.length === 4 && a === "connector" && b === "auth" && c !== undefined) {
    return { kind: "connector-auth", id: c };
  }
  if (t.length === 4 && a === "extension" && b === "approve" && c !== undefined) {
    return { kind: "approve", extensionId: c };
  }
  if (
    t.length === 6 &&
    a === "extension" &&
    b === "credential" &&
    c === "set" &&
    d !== undefined &&
    e !== undefined
  ) {
    return { kind: "credential-set", extensionId: d, name: e };
  }
  return undefined;
}

/** What each fix command runs. `approve` and `credentialSet` each run on a fresh client. */
export type ConnectRunners = {
  readonly connectorAuth: (id: string) => Promise<void>;
  readonly approve: (extensionId: string) => Promise<void>;
  readonly credentialSet: (extensionId: string, name: string) => Promise<void>;
  readonly log: (line: string) => void;
};

/**
 * Runs a requirement's fix commands in order, as `&&` would: a throw stops the rest. An approval
 * the walk already did is skipped. A command this CLI does not recognise is never run, and it
 * stops the sequence too: it and every command after it are logged for the owner to run.
 */
export async function runConnectFix(
  req: RequirementStatusView,
  alreadyApproved: ReadonlySet<string>,
  runners: ConnectRunners,
): Promise<void> {
  for (const [i, command] of req.fix.entries()) {
    const parsed = parseFixCommand(command);
    if (parsed === undefined) {
      for (const rest of req.fix.slice(i)) {
        runners.log(`  not run — run it yourself: ${stripControl(rest)}`);
      }
      return;
    }
    switch (parsed.kind) {
      case "connector-auth":
        await runners.connectorAuth(parsed.id);
        break;
      case "approve":
        if (!alreadyApproved.has(parsed.extensionId)) await runners.approve(parsed.extensionId);
        break;
      case "credential-set":
        await runners.credentialSet(parsed.extensionId, parsed.name);
        break;
    }
  }
}
