import { createServer, type Server, type Socket } from "node:net";

export interface ScriptedNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface ScriptedStep {
  readonly input: string;
  readonly trigger?: string;
  readonly respondAfterNotifications?: boolean;
  readonly notifications: ReadonlyArray<ScriptedNotification>;
  readonly methodResponses?: Readonly<Record<string, unknown>>;
}

export interface EventsScript {
  readonly steps: ReadonlyArray<ScriptedStep>;
}

export interface ConsentDecision {
  readonly requestId: string;
  readonly approved: boolean;
}

export interface FakeGatewayOptions {
  readonly socketPath: string;
  readonly events: EventsScript;
}

const STATUS_GATEWAY_DEFAULT = { uptimeMs: 1000, version: "test", platform: "test" };
const STATUS_INDEX_DEFAULT = { itemCount: 0, p95Latency: 0 };

export class FakeGateway {
  private server: Server | null = null;
  private currentStepIdx = 0;
  private pendingConsent: { requestId: string; resume: () => void } | null = null;
  private earlyConsents = new Map<string, boolean>();
  private activeSockets = new Set<Socket>();
  readonly consentDecisions: ConsentDecision[] = [];

  constructor(private readonly opts: FakeGatewayOptions) {}

  async start(): Promise<void> {
    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
      server.listen(this.opts.socketPath);
    });
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const s = this.server;
    this.server = null;
    s.close();
    if (this.pendingConsent !== null) {
      const resume = this.pendingConsent.resume;
      this.pendingConsent = null;
      resume();
    }
    for (const sock of this.activeSockets) {
      sock.destroy();
    }
    this.activeSockets.clear();
    await new Promise<void>((resolve) => s.once("close", resolve));
  }

  advanceStep(): void {
    this.currentStepIdx += 1;
  }

  private handleConnection(socket: Socket): void {
    this.activeSockets.add(socket);
    socket.once("close", () => this.activeSockets.delete(socket));
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length > 0) {
          this.handleMessage(socket, line);
        }
        nl = buf.indexOf("\n");
      }
    });
    socket.on("error", () => {
      /* ignore — client may close abruptly */
    });
  }

  private handleMessage(socket: Socket, line: string): void {
    let msg: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      this.send(socket, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      this.send(socket, {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }
    const id = msg.id;

    const currentStep = this.opts.events.steps[this.currentStepIdx];
    const stepTrigger = currentStep?.trigger ?? "engine.askStream";
    if (msg.method === stepTrigger) {
      if (id === undefined || id === null) {
        return;
      }
      const result =
        msg.method === "engine.askStream"
          ? { streamId: `stream-${this.currentStepIdx + 1}` }
          : (currentStep?.methodResponses?.[msg.method] ?? null);

      if (currentStep?.respondAfterNotifications === true) {
        void this.emitStepNotifications(socket).then(() => {
          this.send(socket, { jsonrpc: "2.0", id, result });
        });
      } else {
        this.send(socket, { jsonrpc: "2.0", id, result });
        void this.emitStepNotifications(socket);
      }
      return;
    }

    if (msg.method === "consent.respond") {
      const p = msg.params as { requestId?: string; approved?: boolean };
      if (typeof p.requestId === "string" && typeof p.approved === "boolean") {
        if (this.pendingConsent?.requestId === p.requestId) {
          this.consentDecisions.push({ requestId: p.requestId, approved: p.approved });
          const resume = this.pendingConsent.resume;
          this.pendingConsent = null;
          resume();
        } else if (!this.earlyConsents.has(p.requestId)) {
          this.earlyConsents.set(p.requestId, p.approved);
        }
        // Duplicate messages (same requestId seen twice) are silently dropped.
      }
      if (id !== undefined && id !== null) {
        this.send(socket, { jsonrpc: "2.0", id, result: null });
      }
      return;
    }
    if (msg.method === "status.gateway") {
      if (id !== undefined && id !== null) {
        this.send(socket, { jsonrpc: "2.0", id, result: STATUS_GATEWAY_DEFAULT });
      }
      return;
    }
    if (msg.method === "status.index") {
      if (id !== undefined && id !== null) {
        this.send(socket, { jsonrpc: "2.0", id, result: STATUS_INDEX_DEFAULT });
      }
      return;
    }
    const step = this.opts.events.steps[this.currentStepIdx];
    const fixtureResp = step?.methodResponses?.[msg.method];
    if (fixtureResp !== undefined && id !== undefined && id !== null) {
      this.send(socket, { jsonrpc: "2.0", id, result: fixtureResp });
      return;
    }
    if (id !== undefined && id !== null) {
      this.send(socket, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
    }
  }

  private async emitStepNotifications(socket: Socket): Promise<void> {
    const step = this.opts.events.steps[this.currentStepIdx];
    if (step === undefined) return;
    for (const notif of step.notifications) {
      this.send(socket, { jsonrpc: "2.0", method: notif.method, params: notif.params });
      if (notif.method === "consent.request") {
        const p = notif.params as { requestId?: string };
        if (typeof p.requestId === "string") {
          const rid = p.requestId;
          const earlyApproved = this.earlyConsents.get(rid);
          if (earlyApproved !== undefined) {
            this.earlyConsents.delete(rid);
            this.consentDecisions.push({ requestId: rid, approved: earlyApproved });
            // No pause needed — response is already here.
          } else {
            await new Promise<void>((resolve) => {
              this.pendingConsent = { requestId: rid, resume: resolve };
            });
          }
        }
      }
    }
  }

  private send(socket: Socket, msg: unknown): void {
    socket.write(`${JSON.stringify(msg)}\n`);
  }
}
