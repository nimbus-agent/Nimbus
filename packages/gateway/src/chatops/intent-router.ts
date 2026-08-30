import type { OwnerResolution } from "../policy/chatops-policy.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import { parseCommand } from "./command-parser.ts";
import type { ResolveResult } from "./identity-mapper.ts";
import type { ChatMessage, RefusalReason } from "./types.ts";

export interface IntentRouterDeps {
  readonly knownActions: ReadonlySet<string>;
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
    // TODO(Task 8): `IntentRouterDeps` gains `permittedAgents` there; until it does, no agent name
    // is permitted here, so an `agent <name>` message refuses with `unknown_agent` rather than
    // running anything — a fail-closed placeholder, not a behavior this task's tests exercise.
    const cmd = parseCommand(msg.text, this.deps.knownActions, new Set());

    if (idr.kind === "unmapped") {
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
      // Stub only: `permittedAgents` is always the empty set above (Task 8 wires the real
      // `runAgent` + `permittedAgents` deps and replaces this branch), so `parseCommand` can never
      // actually produce `{ kind: "agent" }` here yet — this exists solely so the switch below is
      // exhaustive over `ParsedCommand`, not to define agent-command behavior.
      await this.refuse("bad_agent_params", "Agent commands are not yet wired.", msg.channelId);
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
