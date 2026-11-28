// packages/gateway/test/helpers/iac-fake-child.ts
// A fake IaC runner child for tests: answers `initialize` and one `tools/call` over the runner's
// JSON-RPC line protocol, records what it was sent, and exits when its input closes.
import type { IacChild } from "../../src/connectors/lazy-mesh/iac-runner.ts";

export interface FakeChildSpec {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export class FakeIacChild implements IacChild {
  readonly sent: Array<Record<string, unknown>> = [];
  private lineCb: ((l: string) => void) | undefined;
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  private exited = false;

  /**
   * @param onCall runs when the `tools/call` arrives, before the answer (what the "CLI" does).
   * @param reply the `tools/call` result (default: one empty JSON text block).
   */
  constructor(
    readonly spec: FakeChildSpec,
    private readonly onCall?: () => void,
    private readonly reply: unknown = { content: [{ type: "text", text: "{}" }] },
  ) {}

  send(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg["method"] === "tools/call") this.onCall?.();
    const result = msg["method"] === "initialize" ? {} : this.reply;
    queueMicrotask(() => this.lineCb?.(JSON.stringify({ jsonrpc: "2.0", id: msg["id"], result })));
  }

  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (c: number | null) => void): void {
    if (this.exited) cb(0);
    else this.exitCbs.push(cb);
  }

  kill(_force: boolean): void {
    this.exit();
  }

  closeInput(): void {
    queueMicrotask(() => this.exit());
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(0);
  }

  /** The `tools/call` params the child received, if any. */
  call(): unknown {
    return this.sent.find((m) => m["method"] === "tools/call")?.["params"];
  }
}

/** Lets a child's exit handlers (grant release, then the run's own release) run. */
export function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
