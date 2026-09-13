import { describe, expect, test } from "bun:test";
import type { WatcherFiredPayload } from "../ipc/gateway-events.ts";
import type { WatcherEvalOptions } from "./watcher-engine.ts";

describe("WatcherEvalOptions.onFired", () => {
  test("is a STRUCTURED dep, distinct from the human-prose toast callback", () => {
    // The engine's existing `notify(title, body)` is OS-toast prose (`${w.name}: ${summary}`).
    // Reusing it would make the stream's payload a rendering decision, and — more importantly —
    // would blur a local IPC event with the ChatOps path that `makeChatopsWatcherNotify` is
    // explicitly NOT wired for (I23 / I29 territory). Separate dep, separate purpose.
    const seen: WatcherFiredPayload[] = [];
    const opts: WatcherEvalOptions = { onFired: (p) => seen.push(p) };
    opts.onFired?.({ watcherId: "w1", name: "P0 Incidents", summary: "latency", firedAt: 42 });
    expect(seen).toEqual([
      { watcherId: "w1", name: "P0 Incidents", summary: "latency", firedAt: 42 },
    ]);
  });

  test("is optional, so existing callers compile unchanged", () => {
    const opts: WatcherEvalOptions = { graphConditionsEnabled: true };
    expect(opts.onFired).toBeUndefined();
  });
});
