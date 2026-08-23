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

  test("flags a mutating handler with no registerWriteTool", async () => {
    const root = await fixture();
    await manifest(root, []);
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'const init = { method: "DELETE" };\n',
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
