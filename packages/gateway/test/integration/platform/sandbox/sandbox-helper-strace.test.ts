import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const helperPath = "./packages/gateway/src-native/sandbox-helper/nimbus-sandbox-helper";

describe.skipIf(process.platform !== "linux")(
  "nimbus-sandbox-helper host-namespace invariant",
  () => {
    it.skipIf(!existsSync(helperPath))(
      "does not call setns or unshare(CLONE_NEWUSER) after the initial unshare(CLONE_NEWNET)",
      () => {
        const result = spawnSync(
          "strace",
          ["-e", "trace=setns,unshare", helperPath, "--allow", "example.com", "--", "/bin/true"],
          { encoding: "utf8" },
        );
        const unshareLines = (result.stderr.match(/unshare\(/g) || []).length;
        const setnsLines = (result.stderr.match(/setns\(/g) || []).length;
        expect(setnsLines).toBe(0);
        expect(unshareLines).toBe(1);
      },
    );
  },
);
