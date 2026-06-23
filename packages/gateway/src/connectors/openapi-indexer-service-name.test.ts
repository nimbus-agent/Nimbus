import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferServiceName } from "./openapi-indexer-service-name.ts";

test("step 1: per-spec override in nimbus.openapi.toml wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-svc-"));
  writeFileSync(join(dir, "nimbus.openapi.toml"), `service = "billing-api"\n`);
  writeFileSync(join(dir, "openapi.yaml"), "");
  expect(
    inferServiceName({ specPath: join(dir, "openapi.yaml"), infoTitle: "Other", rootPath: dir }),
  ).toBe("billing-api");
});

test("step 2: enclosing directory name when not at root", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-svc-"));
  const sub = join(root, "services", "payments-api");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "openapi.yaml"), "");
  expect(
    inferServiceName({ specPath: join(sub, "openapi.yaml"), infoTitle: "", rootPath: root }),
  ).toBe("payments-api");
});

test("step 3: info.title slugified when at root and no override", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-svc-"));
  writeFileSync(join(root, "openapi.yaml"), "");
  expect(
    inferServiceName({
      specPath: join(root, "openapi.yaml"),
      infoTitle: "My Cool Service v2",
      rootPath: root,
    }),
  ).toBe("my-cool-service-v2");
});

test("step 4: deterministic sha8 fallback when nothing else applies", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-svc-"));
  writeFileSync(join(root, "openapi.yaml"), "");
  const out = inferServiceName({
    specPath: join(root, "openapi.yaml"),
    infoTitle: "",
    rootPath: root,
  });
  expect(out.startsWith("service-")).toBe(true);
  expect(out).toHaveLength("service-".length + 8);
});

test("fallback is stable across calls for the same path", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-svc-"));
  writeFileSync(join(root, "openapi.yaml"), "");
  const a = inferServiceName({
    specPath: join(root, "openapi.yaml"),
    infoTitle: "",
    rootPath: root,
  });
  const b = inferServiceName({
    specPath: join(root, "openapi.yaml"),
    infoTitle: "",
    rootPath: root,
  });
  expect(a).toBe(b);
});
