import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_ENTRIES, WORKER_OUT_DIR } from "./worker-entries.ts";

const gatewayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const embeddedWorkersSource = readFileSync(
  join(gatewayDir, "src", "workers", "embedded-workers.ts"),
  "utf-8",
);

describe("WORKER_ENTRIES", () => {
  it("is not empty — an empty manifest builds nothing and every worker dies in the binary", () => {
    expect(WORKER_ENTRIES.length).toBeGreaterThan(0);
  });

  // The manifest drives `scripts/build-workers.ts`. A row naming a moved or deleted file makes
  // the build fail loudly, which is the right direction — but catching it here is cheaper than
  // catching it in `compile-gateway.ts`.
  it.each(WORKER_ENTRIES.map((e) => [e.name, e.source]))(
    "%s: its entry source %s exists",
    (_name, source) => {
      expect(existsSync(join(gatewayDir, ...source.split("/")))).toBe(true);
    },
  );

  it("has no duplicate output names — two entries writing one file would silently drop a worker", () => {
    const names = WORKER_ENTRIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // The half the static guard cannot see. `check-worker-entries.ts` proves every `new Worker()`
  // spawns from an `embedded-workers.ts` export; nothing proves the manifest and that module
  // agree. Add a row here, forget the export, and the worker is built but never embedded — back
  // to a `ModuleNotFound` in the binary with a green test suite, which is exactly the failure
  // mode F15 and F22 were.
  it.each(WORKER_ENTRIES.map((e) => [e.name]))("%s is embedded by embedded-workers.ts", (name) => {
    expect(embeddedWorkersSource).toContain(`${WORKER_OUT_DIR}/${name}.js`);
  });

  it("embedded-workers.ts embeds nothing the manifest does not build", () => {
    const embedded = [...embeddedWorkersSource.matchAll(/dist\/workers\/([a-z0-9-]+)\.js/g)].map(
      (m) => m[1],
    );
    const built = WORKER_ENTRIES.map((e) => e.name);
    expect([...new Set(embedded)].sort()).toEqual([...built].sort());
  });

  it("writes inside the gateway package, under a gitignored dist path", () => {
    expect(WORKER_OUT_DIR.startsWith("dist/")).toBe(true);
    expect(WORKER_OUT_DIR).not.toContain("..");
  });
});
