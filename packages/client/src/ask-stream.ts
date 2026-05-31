import type { IPCClient } from "./ipc-transport.js";
import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "./stream-events.js";

type Pending = { resolve: (v: IteratorResult<StreamEvent>) => void; reject: (e: Error) => void };

export function createAskStream(
  ipc: IPCClient,
  input: string,
  opts: AskStreamOptions = {},
): AskStreamHandle {
  const queue: StreamEvent[] = [];
  const waiters: Pending[] = [];
  let done = false;
  let streamIdResolved: string | undefined;
  let cancelled = false;
  let unsubscribers: Array<() => void> = [];

  const push = (ev: StreamEvent): void => {
    if (done) return;
    if (waiters.length > 0) {
      const w = waiters.shift() as Pending;
      w.resolve({ value: ev, done: false });
      return;
    }
    queue.push(ev);
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    for (const u of unsubscribers) u();
    unsubscribers = [];
    while (waiters.length > 0) {
      const w = waiters.shift() as Pending;
      w.resolve({ value: undefined as unknown as StreamEvent, done: true });
    }
  };

  const matchesStream = (params: unknown): params is { streamId: string } => {
    return (
      typeof params === "object" &&
      params !== null &&
      typeof (params as { streamId?: unknown }).streamId === "string"
    );
  };

  const subscribe = (streamId: string): void => {
    const onToken = (params: unknown): void => {
      if (!matchesStream(params) || params.streamId !== streamId) return;
      const text = (params as { text?: unknown }).text;
      if (typeof text === "string") push({ type: "token", text });
    };
    const onDone = (params: unknown): void => {
      if (!matchesStream(params) || params.streamId !== streamId) return;
      const meta = (params as { meta?: { reply?: unknown; sessionId?: unknown } }).meta ?? {};
      const reply = typeof meta.reply === "string" ? meta.reply : "";
      const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : "";
      push({ type: "done", reply, sessionId });
      finish();
    };
    const onError = (params: unknown): void => {
      if (!matchesStream(params) || params.streamId !== streamId) return;
      const code =
        typeof (params as { code?: unknown }).code === "string"
          ? (params as unknown as { code: string }).code
          : "stream_error";
      const message =
        typeof (params as { error?: unknown }).error === "string"
          ? (params as unknown as { error: string }).error
          : "Stream error";
      push({ type: "error", code, message });
      finish();
    };
    const onSubTask = (params: unknown): void => {
      if (!matchesStream(params) || params.streamId !== streamId) return;
      const p = params as {
        subTaskId?: unknown;
        status?: unknown;
        progress?: unknown;
      };
      if (typeof p.subTaskId !== "string" || typeof p.status !== "string") return;
      const ev: StreamEvent =
        typeof p.progress === "number"
          ? {
              type: "subTaskProgress",
              subTaskId: p.subTaskId,
              status: p.status,
              progress: p.progress,
            }
          : { type: "subTaskProgress", subTaskId: p.subTaskId, status: p.status };
      push(ev);
    };
    const onHitl = (params: unknown): void => {
      if (!matchesStream(params) || params.streamId !== streamId) return;
      const p = params as { requestId?: unknown; prompt?: unknown; details?: unknown };
      if (typeof p.requestId !== "string" || typeof p.prompt !== "string") return;
      push({ type: "hitlBatch", requestId: p.requestId, prompt: p.prompt, details: p.details });
    };

    ipc.onNotification("engine.streamToken", onToken);
    ipc.onNotification("engine.streamDone", onDone);
    ipc.onNotification("engine.streamError", onError);
    ipc.onNotification("agent.subTaskProgress", onSubTask);
    ipc.onNotification("agent.hitlBatch", onHitl);

    unsubscribers.push(() => {
      /* no-op: IPCClient has no off() yet; guarded by `done` flag */
    });
  };

  const startPromise = (async (): Promise<string> => {
    const params: Record<string, unknown> = { input };
    if (opts.sessionId !== undefined) params["sessionId"] = opts.sessionId;
    if (opts.agent !== undefined) params["agent"] = opts.agent;
    const result = await ipc.call<{ streamId?: string }>("engine.askStream", params);
    const sid = result?.streamId;
    if (typeof sid !== "string") {
      push({ type: "error", code: "no_stream_id", message: "Gateway returned no streamId" });
      finish();
      throw new Error("no_stream_id");
    }
    streamIdResolved = sid;
    if (cancelled) {
      await ipc.call("engine.cancelStream", { streamId: sid }).catch(() => undefined);
      finish();
      return sid;
    }
    subscribe(sid);
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        await ipc.call("engine.cancelStream", { streamId: sid }).catch(() => undefined);
        finish();
      } else {
        opts.signal.addEventListener("abort", () => {
          void ipc.call("engine.cancelStream", { streamId: sid }).catch(() => undefined);
          finish();
        });
      }
    }
    return sid;
  })();

  startPromise.catch(() => {
    finish();
  });

  const handle: AskStreamHandle = {
    /** Empty string until engine.askStream resolves; safe to read after the first awaited event. */
    get streamId(): string {
      return streamIdResolved ?? "";
    },
    async cancel(): Promise<void> {
      cancelled = true;
      const sid = streamIdResolved;
      if (sid !== undefined) {
        await ipc.call("engine.cancelStream", { streamId: sid }).catch(() => undefined);
      }
      finish();
    },
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      return {
        next(): Promise<IteratorResult<StreamEvent>> {
          if (queue.length > 0) {
            const ev = queue.shift() as StreamEvent;
            return Promise.resolve({ value: ev, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
          }
          return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<StreamEvent>> {
          finish();
          return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
        },
      };
    },
  };

  return handle;
}
