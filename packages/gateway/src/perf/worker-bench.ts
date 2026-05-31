export interface WorkerSpec {
  name: string;
  url: URL;
  config: Record<string, unknown>;
}

export interface WorkerBenchOptions {
  workers: WorkerSpec[];
  durationMs: number;
  sharedDbPath: string;
  WorkerCtor?: typeof Worker;
  timeoutMs?: number;
}

export interface WorkerBenchResult {
  perWorker: {
    name: string;
    writes: number;
    throughputPerSec: number;
    busyRetries: number;
  }[];
  totalThroughputPerSec: number;
  totalBusyRetries: number;
  errors: { name: string; message: string; stack?: string }[];
}

type ParentMsg =
  | { kind: "init"; config: Record<string, unknown>; dbPath: string }
  | { kind: "start"; durationMs: number }
  | { kind: "stop" };

type WorkerMsg =
  | { kind: "ready" }
  | { kind: "done"; writes: number; busyRetries: number }
  | { kind: "error"; message: string; stack?: string };

interface PerWorkerState {
  name: string;
  worker: Worker;
  ready: boolean;
  doneResolve: (v: { writes: number; busyRetries: number }) => void;
  donePromise: Promise<{ writes: number; busyRetries: number }>;
  readyResolve: () => void;
  readyPromise: Promise<void>;
  error?: { message: string; stack?: string };
}

function setupWorker(
  spec: WorkerSpec,
  WorkerCtor: typeof Worker,
  sharedDbPath: string,
): PerWorkerState {
  const worker = new WorkerCtor(spec.url);
  let readyResolve!: () => void;
  let doneResolve!: (v: { writes: number; busyRetries: number }) => void;
  const readyPromise = new Promise<void>((r) => {
    readyResolve = r;
  });
  const donePromise = new Promise<{ writes: number; busyRetries: number }>((r) => {
    doneResolve = r;
  });
  const state: PerWorkerState = {
    name: spec.name,
    worker,
    ready: false,
    doneResolve,
    donePromise,
    readyResolve,
    readyPromise,
  };

  worker.onmessage = (e: MessageEvent<unknown>): void => {
    const msg = e.data as WorkerMsg;
    if (msg.kind === "ready") {
      state.ready = true;
      state.readyResolve();
    } else if (msg.kind === "done") {
      state.doneResolve({ writes: msg.writes, busyRetries: msg.busyRetries });
    } else if (msg.kind === "error") {
      state.error = {
        message: msg.message,
        ...(msg.stack !== undefined && { stack: msg.stack }),
      };
      state.readyResolve();
      state.doneResolve({ writes: 0, busyRetries: 0 });
    }
  };
  worker.onerror = (ev: ErrorEvent): void => {
    state.error = { message: ev.message };
    state.readyResolve();
    state.doneResolve({ writes: 0, busyRetries: 0 });
  };

  const initMsg: ParentMsg = { kind: "init", config: spec.config, dbPath: sharedDbPath };
  worker.postMessage(initMsg);
  return state;
}

function dispatchStart(states: PerWorkerState[], durationMs: number): void {
  const startMsg: ParentMsg = { kind: "start", durationMs };
  for (const s of states) {
    if (s.ready && s.error === undefined) {
      s.worker.postMessage(startMsg);
    }
  }
}

async function awaitDoneOrTimeout(
  states: PerWorkerState[],
  timeoutMs: number,
): Promise<"done" | "timeout"> {
  const deadlineHit = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  const allDone = Promise.all(states.map((s) => s.donePromise)).then(() => "done" as const);
  return Promise.race([allDone, deadlineHit]);
}

function broadcastStop(states: PerWorkerState[]): void {
  const stopMsg: ParentMsg = { kind: "stop" };
  for (const s of states) {
    try {
      s.worker.postMessage(stopMsg);
    } catch {
      /* worker already gone */
    }
  }
}

function terminateAll(states: PerWorkerState[]): void {
  for (const s of states) {
    try {
      s.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}

async function drainAndTerminate(states: PerWorkerState[]): Promise<void> {
  await Promise.race([
    Promise.all(states.map((s) => s.donePromise)),
    new Promise<void>((r) => setTimeout(r, 2_000)),
  ]);
  terminateAll(states);
}

async function collectResults(
  states: PerWorkerState[],
  durationMs: number,
): Promise<{
  perWorker: WorkerBenchResult["perWorker"];
  errors: WorkerBenchResult["errors"];
}> {
  const perWorker: WorkerBenchResult["perWorker"] = [];
  const errors: WorkerBenchResult["errors"] = [];
  for (const s of states) {
    if (s.error !== undefined) {
      errors.push({ name: s.name, ...s.error });
      continue;
    }
    const r = await s.donePromise;
    perWorker.push({
      name: s.name,
      writes: r.writes,
      busyRetries: r.busyRetries,
      throughputPerSec: durationMs > 0 ? r.writes / (durationMs / 1000) : 0,
    });
  }
  return { perWorker, errors };
}

export async function runWorkerBench(opts: WorkerBenchOptions): Promise<WorkerBenchResult> {
  const Ctor = opts.WorkerCtor ?? Worker;
  const timeoutMs = opts.timeoutMs ?? opts.durationMs + 5_000;
  const states: PerWorkerState[] = opts.workers.map((spec) =>
    setupWorker(spec, Ctor, opts.sharedDbPath),
  );

  await Promise.all(states.map((s) => s.readyPromise));

  dispatchStart(states, opts.durationMs);
  const winner = await awaitDoneOrTimeout(states, timeoutMs);

  broadcastStop(states);
  if (winner === "timeout") {
    terminateAll(states);
  } else {
    await drainAndTerminate(states);
  }

  const { perWorker, errors } = await collectResults(states, opts.durationMs);
  const totalThroughputPerSec = perWorker.reduce((acc, w) => acc + w.throughputPerSec, 0);
  const totalBusyRetries = perWorker.reduce((acc, w) => acc + w.busyRetries, 0);

  return { perWorker, totalThroughputPerSec, totalBusyRetries, errors };
}
