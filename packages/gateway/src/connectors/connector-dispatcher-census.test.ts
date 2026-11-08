// packages/gateway/src/connectors/connector-dispatcher-census.test.ts
// D2 whole-branch review finding 1, the census: every production object that IMPLEMENTS
// `ConnectorDispatcher` must either forward `boundWriteCapabilities` or be listed here with the
// reason it is not on an iac path. A new wrapper that returns a fresh `{ dispatch }` fails this
// test instead of silently refusing every iac write.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..");

/** A file that builds a dispatcher object and is NOT on an iac path, with the reason. */
const NOT_ON_AN_IAC_PATH: Readonly<Record<string, string>> = {
  "chatops/chatops-tool-runner-e2e-sink.ts":
    "the e2e sink dispatcher writes a file for the ChatOps e2e tests; no connector, no iac",
  "ipc/server/dispatchers.ts":
    "inline stub dispatchers whose dispatch() refuses or throws; they never reach a connector",
  "ipc/server/vault-dispatch.ts": "a stub whose dispatch() throws; it never reaches a connector",
};

/** A file that builds a dispatcher MUST name the capability (it forwards or sets it). */
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.includes(".test.") && !name.includes("test-helpers")) {
      out.push(p);
    }
  }
}

const IMPLEMENTS = /(:\s*ConnectorDispatcher\s*=\s*\{|\)\s*:\s*ConnectorDispatcher\s*\{)/;

describe("ConnectorDispatcher implementers", () => {
  const files: string[] = [];
  walk(SRC, files);
  const implementers = files
    .map((f) => ({ rel: relative(SRC, f).split(sep).join("/"), text: readFileSync(f, "utf8") }))
    .filter((f) => IMPLEMENTS.test(f.text));

  test("the census finds the known implementers (the scan is not vacuous)", () => {
    const rels = implementers.map((f) => f.rel);
    expect(rels).toContain("connectors/registry.ts");
    expect(rels).toContain("connectors/connector-write-dispatch.ts");
  });

  test("each implementer forwards boundWriteCapabilities or is listed with a reason", () => {
    for (const f of implementers) {
      const forwards = f.text.includes("boundWriteCapabilities");
      const listed = NOT_ON_AN_IAC_PATH[f.rel] !== undefined;
      expect({ file: f.rel, ok: forwards || listed }).toEqual({ file: f.rel, ok: true });
    }
  });

  test("every listed exception is still an implementer (no stale entries)", () => {
    const rels = new Set(implementers.map((f) => f.rel));
    for (const k of Object.keys(NOT_ON_AN_IAC_PATH)) expect(rels.has(k)).toBe(true);
  });
});
