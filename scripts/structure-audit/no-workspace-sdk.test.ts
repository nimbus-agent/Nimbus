import { expect, test } from "bun:test";
import { Glob } from "bun";

test("no package depends on @nimbus-dev/sdk via workspace:*", async () => {
  const offenders: string[] = [];
  for await (const f of new Glob("packages/**/package.json").scan(".")) {
    if (f.includes("node_modules")) continue;
    const pkg: unknown = await Bun.file(f).json();
    if (typeof pkg !== "object" || pkg === null) continue;
    const manifest = pkg as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const deps = manifest[field];
      if (typeof deps !== "object" || deps === null) continue;
      if ((deps as Record<string, unknown>)["@nimbus-dev/sdk"] === "workspace:*") {
        offenders.push(`${f} (${field})`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
