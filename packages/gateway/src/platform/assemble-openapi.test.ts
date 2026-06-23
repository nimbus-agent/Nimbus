import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { DEFAULT_OPENAPI_CONFIG, parseOpenapiToml } from "../connectors/openapi-indexer-config.ts";

test("config dir with [[filesystem.roots]] and [openapi] block parses to compatible options", () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "nimbus-cfg-"));
  writeFileSync(
    join(cfgDir, "nimbus.toml"),
    `
[[filesystem.roots]]
path = "/tmp/some-root"

[openapi]
max_walk_depth = 6
`,
  );
  const roots = loadNimbusFilesystemRootsFromConfigDir(cfgDir);
  expect(roots).toHaveLength(1);
  const cfg = parseOpenapiToml(
    `[openapi]
max_walk_depth = 6`,
  );
  expect(cfg.maxWalkDepth).toBe(6);
  expect(DEFAULT_OPENAPI_CONFIG.maxWalkDepth).toBe(8);
});
