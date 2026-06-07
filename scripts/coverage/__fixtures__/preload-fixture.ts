import { afterAll } from "bun:test";
import { transformSync } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import babelPluginIstanbul from "babel-plugin-istanbul";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { plugin } from "bun";

plugin({
  name: "fixture-instrument",
  setup(build) {
    build.onLoad({ filter: /__fixtures__[/\\]sample[/\\]m\.ts$/ }, (args) => {
      const result = transformSync(readFileSync(args.path, "utf8"), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        retainLines: true,
        presets: [[presetTypescript, { allExtensions: true }]],
        plugins: [[babelPluginIstanbul, {}]],
      });
      return { contents: result?.code ?? "", loader: "js" };
    });
  },
});

afterAll(() => {
  const cov = (globalThis as { __coverage__?: unknown }).__coverage__;
  mkdirSync("coverage/.fixture", { recursive: true });
  writeFileSync("coverage/.fixture/cov.json", JSON.stringify(cov ?? {}));
});
