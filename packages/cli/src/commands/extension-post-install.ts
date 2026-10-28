/**
 * The walk after an ATTENDED `nimbus extension install`: approve each newly installed package to
 * run, then offer to connect each connector it still needs.
 *
 * The walk never approves anything itself. Every approval is the existing `extension approve`
 * command, whose `extension.run` consent prompt is answered by the person at the terminal, so the
 * owner is asked once per package — the prompt IS the question. The walk only runs when the
 * install was attended (stdin and stdout are terminals and there was no `--yes`); unattended, the
 * printed commands stand on their own. Nothing here can make the install fail: every action's
 * failure is logged and the walk moves on.
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

export async function runPostInstallWalk(
  io: PostInstallIo,
  toApprove: readonly string[],
  requirements: readonly RequirementStatusView[],
): Promise<void> {
  if (!io.attended) return;
  // Approvals first: a continuity owner's credential set needs its run grant.
  const approved = new Set<string>();
  if (toApprove.length > 0) {
    io.log("Approve each package to run (you can decline any):");
    for (const id of toApprove) {
      try {
        await io.approve(id);
        approved.add(id);
      } catch (e) {
        io.log(`  ${stripControl(id)}: not approved (${messageOf(e)})`);
      }
    }
  }
  for (const req of requirements) {
    if (req.state !== "not_connected") continue;
    const connector = stripControl(req.connector);
    if (!req.interactive) {
      io.log(`  ${connector}: connect it with: ${req.fix.map(stripControl).join(" && ")}`);
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
 * the walk already did is skipped; a command this CLI does not recognise is logged, not run.
 */
export async function runConnectFix(
  req: RequirementStatusView,
  alreadyApproved: ReadonlySet<string>,
  runners: ConnectRunners,
): Promise<void> {
  for (const command of req.fix) {
    const parsed = parseFixCommand(command);
    if (parsed === undefined) {
      runners.log(`  not run (run it yourself): ${stripControl(command)}`);
      continue;
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
