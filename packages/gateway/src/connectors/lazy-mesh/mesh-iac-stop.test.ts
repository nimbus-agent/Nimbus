// The mesh's teardown also stops the IaC runner (D2 review item 7): its per-run children live
// outside every slot, so a slot-only teardown would leave a Terraform apply running.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { IacRunner } from "./iac-runner.ts";
import { LazyConnectorMesh } from "./mesh.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function meshIn(): LazyConnectorMesh {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-iac-stop-"));
  roots.push(root);
  const paths: PlatformPaths = {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "cache", "sandbox"),
  };
  return new LazyConnectorMesh(paths, createMockVault());
}

test("disconnect stops the IaC runner, and a runner that fails to stop does not fail it", async () => {
  const mesh = meshIn();
  const runner = mesh.iacHost() as IacRunner;
  let stops = 0;
  runner.stop = async () => {
    stops += 1;
  };
  await mesh.disconnect();
  expect(stops).toBe(1);
  runner.stop = async () => {
    throw new Error("stuck");
  };
  await mesh.disconnect();
});
