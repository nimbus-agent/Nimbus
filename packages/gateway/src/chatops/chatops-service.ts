import type { ChatopsStatus } from "../ipc/chatops-rpc.ts";
import type { ChatTransport } from "./transport/transport.ts";
import type { ChatMessage, ChatPlatform, ParsedCommand } from "./types.ts";

/**
 * Lifecycle seam for the ChatOps subsystem. Collaborators (transports, the bound intent-router
 * handler, channel counts, the dry-run parser) are injected so the service stays unit-testable; the
 * gateway boot builds the concrete graph (identity mapper → policy resolvers → reply dispatcher →
 * approval presenter → intent router → transports) and hands it here.
 */
export interface ChatopsServiceDeps {
  readonly enabled: boolean;
  readonly transports: readonly ChatTransport[];
  /** The intent router's `handle`, already wired with the reply dispatcher + owner-routed gate. */
  readonly handleMessage: (m: ChatMessage) => Promise<void>;
  /** Count of policy-bound channels for a platform (status surface only). */
  readonly channelsForPlatform: (platform: ChatPlatform) => number;
  /** Dry-run parse for `chatops.test` (no side effects). */
  readonly testParse: (text: string) => ParsedCommand;
  readonly nowMs?: () => number;
}

export class ChatopsService {
  private lastEventAt: number | undefined;
  private started = false;
  constructor(private readonly deps: ChatopsServiceDeps) {}

  private now(): number {
    return (this.deps.nowMs ?? (() => Date.now()))();
  }

  status(): ChatopsStatus {
    const platforms = this.deps.transports.map((t) => ({
      name: t.platform,
      connected: t.connected(),
      channels: this.deps.channelsForPlatform(t.platform),
    }));
    return this.lastEventAt === undefined
      ? { enabled: this.deps.enabled, platforms }
      : { enabled: this.deps.enabled, platforms, lastEventAt: this.lastEventAt };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const t of this.deps.transports) {
      t.onMessage(async (m) => {
        this.lastEventAt = this.now();
        await this.deps.handleMessage(m);
      });
      await t.start();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const t of this.deps.transports) {
      await t.stop();
    }
  }

  testParse(text: string): ParsedCommand {
    return this.deps.testParse(text);
  }
}
