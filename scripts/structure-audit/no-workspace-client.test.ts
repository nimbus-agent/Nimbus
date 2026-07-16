import { expect, test } from "bun:test";
import { Glob } from "bun";

// After the packages/client extraction, no monorepo package may depend on
// @nimbus-dev/client via any workspace: protocol — it is consumed from npm
// (^0.5.0+). Scan every dependency section and reject any `workspace:` prefix
// (workspace:*, workspace:^, workspace:~, …), not just the literal workspace:*.
test("no package depends on @nimbus-dev/client via a workspace: protocol", async () => {
  const SECTIONS = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;
  const offenders: string[] = [];
  for await (const f of new Glob("packages/**/package.json").scan(".")) {
    if (f.includes("node_modules")) continue;
    const pkg = (await Bun.file(f).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const section of SECTIONS) {
      const dep = pkg[section]?.["@nimbus-dev/client"];
      if (typeof dep === "string" && dep.startsWith("workspace:")) {
        offenders.push(`${f} (${section}: ${dep})`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
