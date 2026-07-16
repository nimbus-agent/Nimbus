import { expect, test } from "bun:test";
import { Glob } from "bun";

// After the packages/client extraction, no monorepo package may depend on
// @nimbus-dev/client via `workspace:*` — it is consumed from npm (^0.5.0+).
test("no package depends on @nimbus-dev/client via workspace:*", async () => {
  const offenders: string[] = [];
  for await (const f of new Glob("packages/**/package.json").scan(".")) {
    if (f.includes("node_modules")) continue;
    const pkg = (await Bun.file(f).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dep =
      pkg.dependencies?.["@nimbus-dev/client"] ?? pkg.devDependencies?.["@nimbus-dev/client"];
    if (dep === "workspace:*") offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
