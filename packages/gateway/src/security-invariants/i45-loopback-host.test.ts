import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { readDirFiles } from "../../test/helpers/security-invariants.ts";
import { LocalIndex } from "../index/local-index.ts";

describe("I45 — a loopback HTTP listener answers only a Host header that names loopback", () => {
  test("the real read-only HTTP server refuses a rebound Host before routing and serves loopback", async () => {
    const { startReadOnlyHttpServer } = await import("../ipc/http-server.ts");
    const dir = mkdtempSync(join(tmpdir(), "nimbus-i45-"));
    const dbPath = join(dir, "nimbus.db");
    const seed = new Database(dbPath);
    LocalIndex.ensureSchema(seed);
    seed.close();
    const handle = startReadOnlyHttpServer(dbPath, 0);
    try {
      // `/v1/items` is what a rebound page would want; the host guard answers before routing.
      const rebound = await fetch(`http://127.0.0.1:${handle.port}/v1/items`, {
        headers: { host: `attacker.example:${handle.port}` },
      });
      expect(rebound.status).toBe(403);
      // Positive control, so the 403 above is not "every request fails". (`/v1/items` itself now
      // needs a `data`-scoped token, so the control uses the always-public health route.)
      const loopback = await fetch(`http://127.0.0.1:${handle.port}/v1/health`, {
        headers: { host: `127.0.0.1:${handle.port}` },
      });
      expect(loopback.status).toBe(200);
    } finally {
      handle.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every production Bun.serve call site runs the guard first", async () => {
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      rel: f.rel,
      contents: stripComments(f.contents),
    }));
    const serving = files.filter((f) => f.contents.includes("Bun.serve(")).map((f) => f.rel);
    expect(serving.sort()).toEqual(["auth/pkce.ts", "ipc/http-server.ts", "ipc/metrics-server.ts"]);
    for (const rel of serving) {
      const src = files.find((f) => f.rel === rel)?.contents ?? "";
      const serveAt = src.indexOf("Bun.serve(");
      const serveBlock = src.slice(serveAt, src.indexOf("registerListener(", serveAt));
      // POSITION and EFFECT: the handler must open with the guard and return its refusal
      // immediately — either `const x = rejectNonLoopbackHost(req); if (x !== null) return x;`
      // or a single `return rejectNonLoopbackHost(req) ?? …`. A call whose result is dropped, or
      // a guard below a route, enforces nothing.
      const handler = /fetch\(req(?::\s*Request)?\)(?::\s*[^{]+)?\s*\{\s*([\s\S]{0,240})/.exec(
        serveBlock,
      );
      expect(handler, `${rel}: no fetch(req) handler found`).not.toBeNull();
      expect(handler?.[1] ?? "").toMatch(
        /^(?:const (\w+) = rejectNonLoopbackHost\(req\);\s*if \(\1 !== null\) return \1;|return rejectNonLoopbackHost\(req\) \?\?)/,
      );
    }
  });
});
