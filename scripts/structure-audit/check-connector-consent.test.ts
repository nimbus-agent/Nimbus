import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorConsent } from "./check-connector-consent.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "consent-audit-"));
  await mkdir(join(root, "packages/mcp-connectors/evil/src"), { recursive: true });
  await mkdir(join(root, "packages/gateway/src/connectors"), { recursive: true });
  return root;
}

async function manifest(root: string, hitl: string[]): Promise<void> {
  await writeFile(
    join(root, "packages/mcp-connectors/evil/nimbus.extension.json"),
    JSON.stringify({ hitlRequired: hitl }),
  );
}

describe("check-connector-consent", () => {
  test("flags setConnectorMode outside its two sanctioned callers", async () => {
    const root = await fixture();
    await manifest(root, []);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'import { setConnectorMode } from "../../shared/connector-mode.ts";\nsetConnectorMode("gateway");\n',
    );
    expect(checkConnectorConsent(root).map((v) => v.rule)).toContain("mode-setter-confined");
  });

  test("does not flag a test file", async () => {
    const root = await fixture();
    await manifest(root, []);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/thing.test.ts"),
      'setConnectorMode("gateway");\n',
    );
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("does NOT flag a verb literal when the manifest declares nothing", async () => {
    // The HTTP-verb signal was REMOVED from this rule, on evidence. With every connector migrated
    // it still produced 32 findings and essentially all were false: search-filter.ts files doing
    // pure filtering, transport helpers like imap-core.ts, the seven read-only connectors that
    // POST for GraphQL/search/auth, kb-append.ts whose tool registers in server.ts, and the
    // standalone launcher's own bin.ts. The rule was per-FILE while migration is per-CONNECTOR,
    // so a helper holding a verb literal never contains the registration.
    const root = await fixture();
    await manifest(root, []);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'const init = { method: "DELETE" };\n',
    );
    expect(checkConnectorConsent(root).map((v) => v.rule)).not.toContain("mutation-declared");
  });

  test("the registrar DECLARATION alone does not count as hardened", async () => {
    // `const registerWriteTool = createWriteToolRegistrar(...)` contains the identifier, so a
    // substring check called a connector hardened even after every write registration had been
    // reverted. Red-proving the gate is what caught it.
    const root = await fixture();
    await manifest(root, ["write"]);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      "const registerWriteTool = createWriteToolRegistrar(server, {});\n" +
        'reg("evil_thing_delete", handler);\n',
    );
    expect(checkConnectorConsent(root).map((v) => v.rule)).toContain("mutation-declared");
  });

  test("flags a connector whose MANIFEST declares write, with no HTTP verb in source", async () => {
    const root = await fixture();
    await manifest(root, ["write"]);
    // Mutates via a CLI, so no verb literal appears anywhere. Ten real connectors look like this.
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'await nimbusSpawn(["kubectl", "delete", "pod", name], {});\n',
    );
    expect(checkConnectorConsent(root).map((v) => v.rule)).toContain("mutation-declared");
  });

  test("does NOT flag a mutating connector that went through the write registrar", async () => {
    const root = await fixture();
    await manifest(root, ["write", "delete"]);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'registerWriteTool("x", { mutates: "a.b" }, "d", s, h);\nconst i = { method: "DELETE" };\n',
    );
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("a read-only connector is clean", async () => {
    const root = await fixture();
    await manifest(root, []);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'const r = await fetch(url, { method: "GET" });\n',
    );
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("an unreadable manifest fails SAFE — treated as declaring a write", async () => {
    const root = await fixture();
    // No manifest written at all.
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      "export const nothing = 1;\n",
    );
    expect(checkConnectorConsent(root).map((v) => v.rule)).toContain("mutation-declared");
  });
});

describe("the real repository", () => {
  test("no production file names setConnectorMode outside its two callers", () => {
    const blocking = checkConnectorConsent().filter((v) => v.rule === "mode-setter-confined");
    expect(blocking).toEqual([]);
  });
});

describe("dependency directories are not connectors", () => {
  test("node_modules under packages/mcp-connectors is skipped, not read as a connector", async () => {
    // Once `packages/mcp-connectors` is a publishable package it always has a node_modules. An
    // unreadable manifest fails SAFE by design, so without the skip that directory reports as a
    // connector declaring ungated writes — a false positive that would block every PR.
    const root = await fixture();
    await manifest(root, []);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      "export const ok = 1;\n",
    );
    await mkdir(join(root, "packages/mcp-connectors/node_modules/some-dep"), { recursive: true });
    await writeFile(
      join(root, "packages/mcp-connectors/node_modules/some-dep/index.ts"),
      "export const dep = 1;\n",
    );
    expect(checkConnectorConsent(root)).toEqual([]);
  });
});
