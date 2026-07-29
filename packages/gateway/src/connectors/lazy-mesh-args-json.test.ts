import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "../index/local-index.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getConnectorHealth } from "./health.ts";
import { LazyConnectorMesh, type MeshLogger } from "./lazy-mesh/index.ts";

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-lazy-mesh-test-"));
  return {
    configDir: root,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

const stubVault: NimbusVault = {
  async get(): Promise<string | null> {
    return null;
  },
  async set(): Promise<void> {},
  async delete(): Promise<void> {},
  async listKeys(): Promise<string[]> {
    return [];
  },
};

type LoggedWarn = { bindings: Record<string, unknown>; msg: string | undefined };

function makeArgsJsonFixture(serviceId: string, argsJson: string) {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const warns: LoggedWarn[] = [];
  const logger: MeshLogger = {
    warn: (b, m) => warns.push({ bindings: b, msg: m }),
  };
  const mesh = new LazyConnectorMesh(makePaths(), stubVault, {
    listUserMcpConnectors: () => [
      {
        service_id: serviceId,
        command: "/bin/echo",
        args_json: argsJson,
        created_at: 0,
      },
    ],
    healthDb: db,
    logger,
  });
  return { db, warns, mesh };
}

async function expectArgsJsonHealthFailure(serviceId: string, argsJson: string): Promise<void> {
  const { db, warns, mesh } = makeArgsJsonFixture(serviceId, argsJson);
  await mesh.ensureUserMcpRunning(serviceId);
  await mesh.disconnect();

  expect(warns.length).toBeGreaterThan(0);
  expect(warns[0]?.bindings["serviceId"]).toBe(serviceId);
  const snap = getConnectorHealth(db, serviceId);
  expect(snap.state).toBe("error");
  expect(snap.lastError ?? "").toMatch(/args_json/);
}

describe("LazyConnectorMesh — args_json failure (S8-F9)", () => {
  test("malformed args_json (parse error) logs warn and transitions health to persistent_error", async () => {
    await expectArgsJsonHealthFailure("broken-svc", "not-json");
  });

  test("malformed args_json (non-string-array) logs warn and transitions health", async () => {
    await expectArgsJsonHealthFailure("non-array-svc", '{"not":"an array"}');
  });

  test("S8-F9 — silent path when no logger / healthDb is wired (legacy callers)", async () => {
    const mesh = new LazyConnectorMesh(makePaths(), stubVault, {
      listUserMcpConnectors: () => [
        {
          service_id: "broken-svc",
          command: "/bin/echo",
          args_json: "not-json",
          created_at: 0,
        },
      ],
    });
    await expect(mesh.ensureUserMcpRunning("broken-svc")).resolves.toBeUndefined();
    await expect(mesh.disconnect()).resolves.toBeUndefined();
  });
});

describe("LazyConnectorMesh — UUID ids (S8-F8)", () => {
  test("source has no Date.now() in MCPClient id literals", () => {
    const dir = join(import.meta.dir, "lazy-mesh");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const src = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(/id:\s*`[^`]*\$\{Date\.now\(\)\}/.test(src)).toBe(false);
    expect(/id:\s*['"][^'"]*Date\.now\(\)/.test(src)).toBe(false);
    expect(src.includes("randomUUID")).toBe(true);
  });
});
