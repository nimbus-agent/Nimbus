// Bun [test].preload — instruments first-party src TS/TSX on load with
// babel-plugin-istanbul so `bun test` accrues line+branch coverage on
// globalThis.__coverage__. Validated recipe (design spec §2):
//   Babel preset-typescript + babel-plugin-istanbul + retainLines (line
//   fidelity) + inline source maps (stack traces). Preset/plugin are passed as
//   FUNCTION REFERENCES (string names crash under Bun's ESM interop), and only
//   first-party src is transformed (a broad filter crashes Babel internals).
import { transformSync } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import babelPluginIstanbul from "babel-plugin-istanbul";
import { readFileSync } from "node:fs";
import { plugin } from "bun";

import { shouldInstrument } from "./instrument-scope.ts";

plugin({
  name: "istanbul-instrument",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
      const isTsx = args.path.endsWith(".tsx");
      const source = readFileSync(args.path, "utf8");
      // onLoad MUST always return an object (returning undefined aborts the run).
      if (!shouldInstrument(args.path)) {
        return { contents: source, loader: isTsx ? "tsx" : "ts" };
      }
      const result = transformSync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        retainLines: true,
        sourceMaps: "inline",
        presets: [[presetTypescript, { allExtensions: true, isTSX: isTsx, allowDeclareFields: true }]],
        plugins: [[babelPluginIstanbul, {}]],
      });
      const code = result?.code ?? source;
      // Instrumented output is plain JS(X); JSX must keep the jsx loader.
      return { contents: code, loader: isTsx ? "jsx" : "js" };
    });
  },
});
