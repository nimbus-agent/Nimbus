import type { ChatopsAgentInvoker } from "../agent-runs/agent-chatops-invoke.ts";
import type { OwnerResolution } from "../policy/chatops-policy.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import { parseCommand } from "./command-parser.ts";
import type { ResolveResult } from "./identity-mapper.ts";
import type { ChatMessage, RefusalReason } from "./types.ts";

export interface IntentRouterDeps {
  readonly knownActions: ReadonlySet<string>;
  /** Agent names an `agent <name> ...` command may invoke — mapped identities only (see `handle`). */
  readonly permittedAgents: ReadonlySet<string>;
  readonly resolveBinding: (channelId: string) => ChatopsChannelBinding | undefined;
  readonly resolveIdentity: (platform: "slack" | "teams", userId: string) => Promise<ResolveResult>;
  readonly resolveOwner: (resource: string) => OwnerResolution;
  readonly ownerExternalIdFor: (email: string) => string | undefined;
  readonly askEngine: (query: string, namespace: string) => Promise<string>;
  /** Runs the write through the executor HITL gate with owner-routing context already set up. */
  readonly runGatedWrite: (
    actionType: string,
    args: Readonly<Record<string, string>>,
    owner: { email: string; externalId: string },
    requesterExternalId: string,
    originatingChannelId: string,
  ) => Promise<{ approved: boolean }>;
  /** Runs an `agent <name> ...` command. Truncation to a platform byte cap is the boot wiring's
   *  job (Task 9) — this router stays free of any platform-specific cap. */
  readonly runAgent: ChatopsAgentInvoker;
  readonly reply: (text: string) => Promise<void>;
  readonly auditRefusal: (reason: RefusalReason, detail: string, channelId: string) => void;
}

export class IntentRouter {
  constructor(private readonly deps: IntentRouterDeps) {}

  private async refuse(reason: RefusalReason, detail: string, channelId: string): Promise<void> {
    this.deps.auditRefusal(reason, detail, channelId);
    await this.deps.reply(detail);
  }

  async handle(msg: ChatMessage): Promise<void> {
    const binding = this.deps.resolveBinding(msg.channelId);
    if (binding === undefined) return; // unbound channel: bot stays silent (fail-closed)

    const idr = await this.deps.resolveIdentity(msg.platform, msg.userId);
    const cmd = parseCommand(msg.text, this.deps.knownActions, this.deps.permittedAgents);

    if (idr.kind === "unmapped") {
      // `public-read` admits an unmapped user to `read` only. An `agent` command falls through to
      // the refusal below with no extra code — three of the eleven agents fan out to paired peers,
      // and widening a shipped permission by inheritance rather than by decision is exactly the
      // shape this fail-closed default exists to prevent. See the mapped-identity rule at the top
      // of this file's brief.
      if (cmd.kind === "read" && binding.unmapped === "public-read") {
        await this.deps.reply(await this.deps.askEngine(cmd.query, binding.namespace));
        return;
      }
      await this.refuse("unmapped_user", "You are not enrolled for this channel.", msg.channelId);
      return;
    }

    if (cmd.kind === "refused") {
      await this.refuse(cmd.reason, cmd.detail, msg.channelId);
      return;
    }
    if (cmd.kind === "read") {
      await this.deps.reply(await this.deps.askEngine(cmd.query, binding.namespace));
      return;
    }
    if (cmd.kind === "agent") {
      const result = await this.deps.runAgent(cmd.agent, cmd.params);
      if (!result.ok) {
        await this.refuse("bad_agent_params", result.detail, msg.channelId);
        return;
      }
      await this.deps.reply(result.markdown);
      return;
    }

    // write
    const owner = this.deps.resolveOwner(cmd.resource);
    if (owner.kind === "none") {
      await this.refuse("no_owner", `No owner configured for '${cmd.resource}'.`, msg.channelId);
      return;
    }
    if (owner.kind === "ambiguous") {
      await this.refuse(
        "ambiguous_owner",
        `Ambiguous ownership for '${cmd.resource}'.`,
        msg.channelId,
      );
      return;
    }
    const ownerExternalId = this.deps.ownerExternalIdFor(owner.email);
    if (ownerExternalId === undefined) {
      await this.refuse(
        "no_owner",
        `Owner '${owner.email}' has no Nimbus identity.`,
        msg.channelId,
      );
      return;
    }
    const result = await this.deps.runGatedWrite(
      cmd.actionType,
      cmd.args,
      { email: owner.email, externalId: ownerExternalId },
      idr.identity.externalId,
      msg.channelId,
    );
    await this.deps.reply(
      result.approved
        ? `✅ ${cmd.actionType} approved & executed.`
        : `❌ ${cmd.actionType} rejected.`,
    );
  }
}
