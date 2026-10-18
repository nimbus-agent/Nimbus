/**
 * The action runs on node24 from its committed bundle, with no `node_modules` and no Bun. This
 * builds the bundle the way `package.json`'s `build` does and inspects its import graph: no
 * `bun:*` module or `Bun` global, nothing from the gateway, the CLI or the UI, no DB or sqlite-vec
 * module, and nothing left external except node built-ins (a bare npm import would fail on the
 * runner, which installs nothing). It also proves the graph is the real one — the shared
 * registry-format validator and signer are in it — so the checks cannot pass on an empty bundle.
 */
import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { join } from "node:path";

interface MetaImport {
  path: string;
  kind: string;
  external?: boolean;
}

interface Metafile {
  inputs: Record<string, { imports: MetaImport[] }>;
}

const PKG = join(import.meta.dir, "..");

const result = await Bun.build({
  entrypoints: [join(PKG, "src", "main.ts")],
  target: "node",
  format: "esm",
  metafile: true,
});

function metafile(): Metafile {
  const raw: unknown = result.metafile;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Metafile;
}

const slash = (p: string): string => p.replaceAll("\\", "/");
const inputs = Object.keys(metafile().inputs).map(slash);
const imports = Object.values(metafile().inputs).flatMap((i) => i.imports);
const externals = [...new Set(imports.filter((i) => i.external === true).map((i) => i.path))];
const bundle = await result.outputs[0]?.text();

const NODE_BUILTINS = new Set(builtinModules);
const isNodeBuiltin = (spec: string): boolean =>
  spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? spec);

describe("registry action bundle closure", () => {
  test("builds", () => {
    expect(result.success).toBe(true);
    expect(bundle).toBeString();
  });

  test("the bundle contains the shared registry-format rules", () => {
    for (const file of ["validate-publish.ts", "sign.ts", "index-format.ts"]) {
      expect(inputs.some((p) => p.endsWith(`registry-format/src/${file}`))).toBe(true);
    }
  });

  test("closure test: the bundle has no bun:* import and does not reach gateway, cli, DB or sqlite-vec modules", () => {
    // `bun:wrap` is the bundler's own virtual module for the CommonJS interop helpers: it is
    // inlined into the bundle, never imported at runtime (the text check below proves no `bun:`
    // specifier survives), so it is the one `bun:` path the graph may name, and never external.
    const bunPaths = [...inputs, ...imports.map((i) => slash(i.path))].filter((p) =>
      p.startsWith("bun:"),
    );
    expect(bunPaths.filter((p) => p !== "bun:wrap")).toEqual([]);
    expect(imports.filter((i) => i.external === true && i.path.startsWith("bun:"))).toEqual([]);
    expect(bundle).not.toMatch(/["']bun:/);
    expect(bundle).not.toMatch(/\bBun\.\w/);

    const forbidden = [
      /(^|\/)(gateway|cli|ui)\/(src|test)\//,
      /sqlite/i,
      /(^|\/)migrations?\//,
      /(^|\/)(db|index)\/[^/]*\.ts$/,
    ];
    const reached = inputs.filter(
      (p) => !p.includes("/node_modules/") && forbidden.some((re) => re.test(p)),
    );
    expect(reached).toEqual([]);
    expect(inputs.filter((p) => /sqlite/i.test(p))).toEqual([]);
  });

  test("nothing but node built-ins is left external", () => {
    expect(externals.length).toBeGreaterThan(0);
    expect(externals.filter((e) => !isNodeBuiltin(e))).toEqual([]);
  });
});
