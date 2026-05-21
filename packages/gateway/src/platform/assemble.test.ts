import { describe, expect, it } from "bun:test";

import { assemblePlatformServices } from "./assemble.ts";

describe("assemblePlatformServices (smoke)", () => {
  it("is an async function with arity 1 (paths)", () => {
    // assemble.ts wires twenty subsystems (vault, embeddings, mesh, IPC,
    // updater, autoupdate, telemetry, …) and exposes a single entry point.
    // Full coverage requires spinning up a real gateway subprocess —
    // exercised by the integration suite and the headless smoke. We assert
    // the contract surface here so a future signature/arity change fails
    // before the heavier integration runs.
    expect(typeof assemblePlatformServices).toBe("function");
    expect(assemblePlatformServices.length).toBe(1);
    // It's an async function (returns a Promise).
    expect(assemblePlatformServices.constructor.name).toBe("AsyncFunction");
  });
});
