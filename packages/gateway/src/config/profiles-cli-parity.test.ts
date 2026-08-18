import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gateway (config/profiles.ts) and the CLI (cli/src/commands/profile.ts) are two
// independent implementations of the same on-disk format. Converging them is follow-up work;
// until then this pins the three constants they must agree on, so a change to one that is not
// mirrored in the other fails here instead of in a user's config directory.
describe("gateway/CLI profile format parity", () => {
  const gateway = readFileSync(join(import.meta.dir, "profiles.ts"), "utf8");
  const cli = readFileSync(
    join(import.meta.dir, "..", "..", "..", "cli", "src", "commands", "profile.ts"),
    "utf8",
  );

  for (const constant of [
    'const PROFILE_MARKER = ".nimbus-profile"',
    'const PROFILE_PREFIX = "nimbus."',
    'const PROFILE_SUFFIX = ".toml"',
  ]) {
    test(`both declare ${constant}`, () => {
      expect(gateway).toContain(constant);
      expect(cli).toContain(constant);
    });
  }
});
