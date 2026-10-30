// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are source text for the scanner to parse.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  auditConnectorHosts,
  type ConnectorHostGaps,
  findUndeclaredHosts,
  parseGapsFile,
  scanSource,
} from "./check-connector-hosts.ts";

describe("findUndeclaredHosts", () => {
  test("a declared host is not reported", () => {
    expect(findUndeclaredHosts('fetch("https://api.foo.com/v1")', ["api.foo.com"])).toEqual([]);
  });

  test("an undeclared host is reported", () => {
    expect(findUndeclaredHosts('fetch("https://api.foo.com/v1")', [])).toEqual(["api.foo.com"]);
  });

  test("comments do not call", () => {
    expect(findUndeclaredHosts("// see https://docs.foo.com/x", [])).toEqual([]);
    expect(findUndeclaredHosts("/* https://docs.foo.com/x */ const a = 1;", [])).toEqual([]);
  });

  test("a host built from config is dynamic", () => {
    expect(findUndeclaredHosts("const u = `https://${host}/v1`", [])).toEqual([]);
    expect(findUndeclaredHosts("const u = `https://api.${site}`", [])).toEqual([]);
    expect(findUndeclaredHosts("const u = `https://${a}.snowflake.com/x`", [])).toEqual([]);
  });

  test("a fixed host in a template with a substituted path is still found", () => {
    expect(findUndeclaredHosts("const u = `https://api.foo.com/${id}/x`", [])).toEqual([
      "api.foo.com",
    ]);
    expect(findUndeclaredHosts("const u = `https://api.foo.com${path}`", [])).toEqual([
      "api.foo.com",
    ]);
  });

  test("a URL inside a template substitution is found", () => {
    expect(findUndeclaredHosts('const u = `${x ?? "https://api.foo.com"}/v1`', [])).toEqual([
      "api.foo.com",
    ]);
  });

  test("a host mid-sentence in a description is found, for the gaps file to classify", () => {
    expect(findUndeclaredHosts('const d = "see https://docs.foo.com, then retry"', [])).toEqual([
      "docs.foo.com",
    ]);
  });

  test("the port is part of the grant: plain http is not the bare entry", () => {
    expect(findUndeclaredHosts('fetch("http://api.foo.com/v1")', ["api.foo.com"])).toEqual([
      "api.foo.com:80",
    ]);
    expect(findUndeclaredHosts('fetch("http://api.foo.com/v1")', ["api.foo.com:80"])).toEqual([]);
    expect(findUndeclaredHosts('fetch("https://api.foo.com:8443")', ["api.foo.com"])).toEqual([
      "api.foo.com:8443",
    ]);
    expect(findUndeclaredHosts('fetch("https://api.foo.com:443/x")', ["api.foo.com"])).toEqual([]);
  });

  test("websocket schemes count, and case does not matter", () => {
    expect(findUndeclaredHosts('new WebSocket("wss://gw.foo.com/x")', [])).toEqual(["gw.foo.com"]);
    expect(findUndeclaredHosts('fetch("https://API.Foo.com")', ["api.foo.COM"])).toEqual([]);
  });

  test("a scheme with no host is not a host", () => {
    expect(findUndeclaredHosts('p.startsWith("https://")', [])).toEqual([]);
    expect(findUndeclaredHosts('const d = "the wss:// URL"', [])).toEqual([]);
  });

  test("each host is reported once, sorted", () => {
    const src = 'a("https://b.foo.com/1"); a("https://a.foo.com"); a("https://b.foo.com/2");';
    expect(findUndeclaredHosts(src, [])).toEqual(["a.foo.com", "b.foo.com"]);
  });
});

describe("scanSource", () => {
  test("flags a host the scan cannot read", () => {
    expect(scanSource("const u = `https://${host}/v1`").dynamicUrl).toBe(true);
    expect(scanSource('fetch("https://api.foo.com")').dynamicUrl).toBe(false);
  });

  test("flags a host taken from an env var", () => {
    expect(scanSource('const b = requiredBaseUrl("FOO_URL")').configHostEnv).toEqual(["FOO_URL"]);
    expect(scanSource('const h = process.env["FOO_TOKEN"]').configHostEnv).toEqual([]);
  });

  test("flags a shell-out", () => {
    expect(scanSource('import { x } from "../../../shared/run-cli-json.ts";').shellsOut).toBe(true);
    expect(scanSource('import { x } from "../../../shared/nimbus-spawn.ts";').shellsOut).toBe(true);
    expect(scanSource('import { x } from "node:child_process";').shellsOut).toBe(true);
    expect(scanSource('import { x } from "../../../shared/cli-json-kit.ts";').shellsOut).toBe(
      false,
    );
  });

  test("lists relative imports, including re-exports", () => {
    const src = 'import a from "./a.ts"; export { b } from "../b.ts"; import c from "zod";';
    expect(scanSource(src).relativeImports).toEqual(["./a.ts", "../b.ts"]);
  });
});

describe("parseGapsFile", () => {
  const empty = {
    manifestsWithoutConnector: {},
    connectorsWithoutManifest: {},
    literalGaps: [],
    knownUnreachable: [],
    handRead: {},
  };

  test("accepts a complete file", () => {
    expect(parseGapsFile(JSON.stringify(empty)).literalGaps).toEqual([]);
  });

  test("refuses an empty reason, and a gap kind it does not know", () => {
    const base = { connector: "a", host: "x.foo.com" };
    expect(() =>
      parseGapsFile(
        JSON.stringify({ ...empty, literalGaps: [{ ...base, kind: "not called", reason: " " }] }),
      ),
    ).toThrow(/reason/);
    expect(() =>
      parseGapsFile(
        JSON.stringify({ ...empty, literalGaps: [{ ...base, kind: "whatever", reason: "r" }] }),
      ),
    ).toThrow(/kind/);
  });

  test("a declared-at-spawn gap must name the file", () => {
    expect(() =>
      parseGapsFile(
        JSON.stringify({
          ...empty,
          literalGaps: [
            { connector: "a", host: "x.foo.com", kind: "declared at spawn", reason: "r" },
          ],
        }),
      ),
    ).toThrow(/file/);
  });
});

describe("auditConnectorHosts", () => {
  const dirs: string[] = [];

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "connector-hosts-"));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    return root;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function gaps(over: Partial<ConnectorHostGaps> = {}): ConnectorHostGaps {
    return {
      manifestsWithoutConnector: {},
      connectorsWithoutManifest: {},
      literalGaps: [],
      knownUnreachable: [],
      handRead: {},
      ...over,
    };
  }

  function run(
    root: string,
    manifests: Record<string, readonly string[]>,
    g: ConnectorHostGaps = gaps(),
  ) {
    return auditConnectorHosts({ packageRoot: root, repoRoot: root, manifests, gaps: g });
  }

  test("clean when every literal host is declared, and counts what it scanned", () => {
    const root = fixture({ "connectors/foo/src/tools.ts": 'fetch("https://api.foo.com/v1");' });
    const r = run(root, { foo: ["api.foo.com"] });
    expect(r.problems).toEqual([]);
    expect(r.connectorsScanned).toBe(1);
    expect(r.filesScanned).toBe(1);
  });

  test("an empty package is a failure, never a clean pass", () => {
    const root = fixture({ "package.json": "{}" });
    expect(run(root, {}).problems.join("\n")).toContain("no connectors");
  });

  test("a missing connectors directory is a failure", () => {
    const root = fixture({ "package.json": "{}" });
    expect(run(join(root, "nope"), {}).problems.join("\n")).toContain("no connectors");
  });

  test("an undeclared host fails and names the connector", () => {
    const root = fixture({ "connectors/foo/src/tools.ts": 'fetch("https://api.foo.com/v1");' });
    expect(run(root, { foo: [] }).problems.join("\n")).toContain("foo: api.foo.com");
  });

  test("a test file does not count", () => {
    const root = fixture({ "connectors/foo/src/tools.test.ts": 'fetch("https://api.foo.com");' });
    expect(run(root, { foo: [] }).problems).toEqual([]);
  });

  test("a shared file the connector imports is scanned, transitively", () => {
    const root = fixture({
      "connectors/foo/src/tools.ts": 'import "../../../shared/a.ts";',
      "shared/a.ts": 'import "./b.ts";',
      "shared/b.ts": 'fetch("https://api.shared.com");',
    });
    expect(run(root, { foo: [] }).problems.join("\n")).toContain("foo: api.shared.com");
  });

  test("a shared file the connector does NOT import does not count against it", () => {
    const root = fixture({
      "connectors/foo/src/tools.ts": "export const a = 1;",
      "shared/b.ts": 'fetch("https://api.shared.com");',
    });
    expect(run(root, { foo: [] }).problems).toEqual([]);
  });

  test("a manifest key matches its directory across - and _ and spelling", () => {
    const root = fixture({
      "connectors/google-drive/src/a.ts": 'fetch("https://drive.foo.com");',
      "connectors/monte-carlo/src/a.ts": 'fetch("https://mc.foo.com");',
    });
    const r = run(root, { google_drive: ["drive.foo.com"], montecarlo: ["mc.foo.com"] });
    expect(r.problems).toEqual([]);
  });

  test("a manifest with no directory fails unless recorded", () => {
    const root = fixture({ "connectors/foo/src/a.ts": "" });
    expect(run(root, { foo: [], ghost: [] }).problems.join("\n")).toContain("ghost");
    expect(
      run(
        root,
        { foo: [], ghost: [] },
        gaps({ manifestsWithoutConnector: { ghost: "built elsewhere" } }),
      ).problems,
    ).toEqual([]);
  });

  test("a directory with no manifest fails unless recorded, and is still scanned", () => {
    const root = fixture({ "connectors/orphan/src/a.ts": 'fetch("https://api.orphan.com");' });
    expect(run(root, {}).problems.join("\n")).toContain("orphan");
    const recorded = gaps({
      connectorsWithoutManifest: { orphan: { reason: "spawn only", network: [] } },
    });
    expect(run(root, {}, recorded).problems.join("\n")).toContain("orphan: api.orphan.com");
    const declared = gaps({
      connectorsWithoutManifest: { orphan: { reason: "spawn only", network: ["api.orphan.com"] } },
    });
    expect(run(root, {}, declared).problems).toEqual([]);
  });

  test("a recorded gap excuses its host", () => {
    const root = fixture({ "connectors/foo/src/a.ts": 'const d = "see https://docs.foo.com";' });
    const g = gaps({
      literalGaps: [
        { connector: "foo", host: "docs.foo.com", kind: "not called", reason: "a link" },
      ],
    });
    expect(run(root, { foo: [] }, g).problems).toEqual([]);
  });

  test("a gap nothing needs any more fails, so the file cannot rot", () => {
    const root = fixture({ "connectors/foo/src/a.ts": "export const a = 1;" });
    const g = gaps({
      literalGaps: [
        { connector: "foo", host: "docs.foo.com", kind: "not called", reason: "a link" },
      ],
    });
    expect(run(root, { foo: [] }, g).problems.join("\n")).toContain("stale");
  });

  test("a gap for a host now declared is stale too", () => {
    const root = fixture({ "connectors/foo/src/a.ts": 'fetch("https://api.foo.com");' });
    const g = gaps({
      literalGaps: [{ connector: "foo", host: "api.foo.com", kind: "not called", reason: "x" }],
    });
    expect(run(root, { foo: ["api.foo.com"] }, g).problems.join("\n")).toContain("stale");
  });

  test("declared at spawn must really be in the file it names", () => {
    const source = { "connectors/foo/src/a.ts": 'fetch("https://api.foo.com");' };
    const g = gaps({
      literalGaps: [
        {
          connector: "foo",
          host: "api.foo.com",
          kind: "declared at spawn",
          reason: "bot only",
          file: "spawn.ts",
        },
      ],
    });
    const absent = fixture({ ...source, "spawn.ts": "nothing here" });
    expect(run(absent, { foo: [] }, g).problems.join("\n")).toContain("spawn.ts");
    const present = fixture({ ...source, "spawn.ts": 'const h = "api.foo.com";' });
    expect(run(present, { foo: [] }, g).problems).toEqual([]);
  });

  test("a connector that shells out needs a hand-read record", () => {
    const root = fixture({
      "connectors/foo/src/a.ts": 'import "../../../shared/nimbus-spawn.ts";',
    });
    expect(run(root, { foo: [] }).problems.join("\n")).toContain("foo: shells out");
    expect(
      run(
        root,
        { foo: [] },
        gaps({ handRead: { foo: { reaches: "foo.com", decision: "declared" } } }),
      ).problems,
    ).toEqual([]);
  });

  test("a connector with a dynamic URL or a host from an env var needs a hand-read record", () => {
    const dynamic = fixture({ "connectors/foo/src/a.ts": "const u = `https://${h}/x`;" });
    expect(run(dynamic, { foo: [] }).problems.join("\n")).toContain("foo: builds a URL");
    const env = fixture({ "connectors/foo/src/a.ts": 'const b = requiredBaseUrl("FOO_URL");' });
    expect(run(env, { foo: [] }).problems.join("\n")).toContain("FOO_URL");
  });

  test("a record for a connector that does not exist fails", () => {
    const root = fixture({ "connectors/foo/src/a.ts": "" });
    const g = gaps({
      handRead: { gone: { reaches: "x", decision: "y" } },
      knownUnreachable: [{ connector: "gone2", hosts: "x", kind: "redirect only", reason: "r" }],
    });
    const out = run(root, { foo: [] }, g).problems.join("\n");
    expect(out).toContain("gone");
    expect(out).toContain("gone2");
  });
});
