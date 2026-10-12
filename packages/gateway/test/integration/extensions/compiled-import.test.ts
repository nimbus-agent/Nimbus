// R1 of the extension-runtime design (docs/superpowers/specs/2026-10-11-extension-runtime-design.md
// § 9): the runtime will launch an installed extension as a self-role of the COMPILED gateway that
// `import()`s the extension's entry file from disk. First-party connectors never exercise that
// path — they are bundled into the binary — so nothing else in the suite proves a
// `bun build --compile` executable can load an on-disk ES module, follow its relative imports, and
// resolve its own `node_modules` (ESM and CommonJS). This test compiles a minimal host doing
// exactly that and runs it from an unrelated cwd, on every PR leg, so all three OSes answer R1.
//
// Unconfined on purpose: confinement is the runtime's job (PR 3), and this file isolates the one
// question the sandbox cannot change — whether the loader works at all in a compiled binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_TS = `import { pathToFileURL } from "node:url";
const entry = process.argv[2];
if (entry === undefined) process.exit(2);
await import(pathToFileURL(entry).href);
`;

const ENTRY_JS = `import { helper } from "./chunk.js";
import esm from "esm-dep";
import cjs from "cjs-dep";
console.log(JSON.stringify({ chunk: helper(), esm: esm(), cjs: cjs.v }));
`;

async function run(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

describe("a compiled binary importing an on-disk extension entry (R1)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-r1-"));
  const hostDir = join(tmp, "host");
  const host = join(hostDir, process.platform === "win32" ? "host.exe" : "host");
  const ext = join(tmp, "ext");
  const elsewhere = join(tmp, "elsewhere");

  beforeAll(async () => {
    write(join(hostDir, "main.ts"), HOST_TS);
    write(join(ext, "package.json"), JSON.stringify({ type: "module" }));
    write(join(ext, "dist", "server.js"), ENTRY_JS);
    write(join(ext, "dist", "chunk.js"), `export const helper = () => "chunk-ok";\n`);
    write(
      join(ext, "node_modules", "esm-dep", "package.json"),
      JSON.stringify({ name: "esm-dep", type: "module", main: "index.js" }),
    );
    write(join(ext, "node_modules", "esm-dep", "index.js"), `export default () => "esm-ok";\n`);
    write(
      join(ext, "node_modules", "cjs-dep", "package.json"),
      JSON.stringify({ name: "cjs-dep", main: "index.js" }),
    );
    write(join(ext, "node_modules", "cjs-dep", "index.js"), `module.exports = { v: "cjs-ok" };\n`);
    mkdirSync(elsewhere, { recursive: true });

    // No `--target`: embeds the running bun and downloads nothing (as user-mcp.e2e.test.ts does).
    const build = await run(["bun", "build", "--compile", "main.ts", "--outfile", host], hostDir);
    if (build.code !== 0) {
      throw new Error(`bun build exited ${build.code}:\n${build.stdout}\n${build.stderr}`);
    }
  }, 180_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("loads the entry, its relative chunk, and ESM + CJS node_modules", async () => {
    const out = await run([host, join(ext, "dist", "server.js")], elsewhere);
    expect({ code: out.code, stderr: out.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(out.stdout.trim())).toEqual({
      chunk: "chunk-ok",
      esm: "esm-ok",
      cjs: "cjs-ok",
    });
  }, 60_000);
});
