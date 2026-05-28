import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReadOnlyHttpServer } from "../../../src/ipc/http-server.ts";

describe("GET /v1/openapi.json", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;
  let port: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-openapi-route-"));
    dbPath = join(tmpDir, "nimbus.db");
    new Database(dbPath).close();
    handle = startReadOnlyHttpServer(dbPath, 0);
    port = handle.port;
  });

  afterEach(() => {
    handle?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a parseable OpenAPI 3.1 document", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Nimbus Local HTTP API");
    expect(body.paths["/v1/openapi.json"]).toBeDefined();
    expect(body.paths["/v1/items"]).toBeDefined();
  });

  it("returns identical bytes on repeated requests (cached)", async () => {
    const a = await (await fetch(`http://127.0.0.1:${port}/v1/openapi.json`)).text();
    const b = await (await fetch(`http://127.0.0.1:${port}/v1/openapi.json`)).text();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(500);
  });
});
