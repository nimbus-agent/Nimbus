import { expect, test } from "bun:test";
import { Glob } from "bun";

test("no package depends on @nimbus-dev/sdk via workspace:*", async () => {
  const offenders: string[] = [];
  for await (const f of new Glob("packages/**/package.json").scan(".")) {
    if (f.includes("node_modules")) continue;
    const pkg = await Bun.file(f).json();
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      if (pkg[field]?.["@nimbus-dev/sdk"] === "workspace:*") offenders.push(`${f} (${field})`);
    }
  }
  expect(offenders).toEqual([]);
});
