import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import { runPeople } from "./people.ts";
import { runQuery } from "./query.ts";

// The three commands exactly as `docs/superpowers/specs/2026-08-20-negation-queries-design.md`
// documents them. If a doc example stops parsing, this file fails — which is the point.
const DOCUMENTED = [
  ["query", ["--service", "github", "--type", "pr", "--not-touching", "tests/**"]],
  ["query", ["--service", "github", "--type", "deployment", "--no-downstream-incident"]],
  ["people", ["list", "--not-reviewed", "--since", "7d"]],
] as const;

// `withGatewayIpc` looks up the gateway state file at `<dataDir>/gateway.json`
// (`packages/cli/src/lib/gateway-process.ts` `gatewayStatePath`). `dataDir` is derived
// per-platform in `packages/cli/src/paths.ts` and is deliberately NOT moved by
// `NIMBUS_CONFIG_DIR` — that comment ("Only `configDir` moves") is pinned by
// `paths.test.ts`'s "leaves dataDir alone" case, and verified again here: probing
// `getCliPlatformPaths()` with only `NIMBUS_CONFIG_DIR` set left `dataDir` pointed at the
// real per-user data directory. Isolating this test therefore means overriding the env var
// that actually feeds `dataDir` on the platform the test runs on: `LOCALAPPDATA` (+
// `APPDATA`, required or `getCliPlatformPaths` throws) on win32, `HOME` on darwin (consumed
// by `os.homedir()`), `XDG_DATA_HOME` everywhere else. Overriding all four is harmless on
// every OS and keeps the test from depending on whether a real gateway happens to be
// running on the machine it executes on.
const DATA_DIR_ENV_KEYS = ["APPDATA", "LOCALAPPDATA", "HOME", "XDG_DATA_HOME"] as const;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function isolateGatewayState(root: string): () => void {
  const saved: Partial<Record<(typeof DATA_DIR_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of DATA_DIR_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  process.env["APPDATA"] = join(root, "appdata");
  process.env["LOCALAPPDATA"] = join(root, "localappdata");
  process.env["HOME"] = join(root, "home");
  process.env["XDG_DATA_HOME"] = join(root, "xdg-data");
  return () => {
    for (const key of DATA_DIR_ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  };
}

/**
 * Runs `runQuery` / `runPeople` and returns the combined failure text: a thrown message
 * (that's how `runQuery` rejects bad input) plus anything written to `console.error`
 * (that's how `runPeople` rejects an unknown subcommand — it sets `process.exitCode`
 * rather than throwing). Capturing only exceptions would make the people case pass
 * vacuously, since a bad `people` subcommand never throws.
 */
async function captureError(cmd: "query" | "people", args: string[]): Promise<string> {
  out.reset();
  let thrown = "";
  try {
    if (cmd === "query") {
      await runQuery(args);
    } else {
      await runPeople(args);
    }
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  const combined = `${thrown}\n${out.stderr}`;
  out.reset();
  return combined;
}

describe("documented negation examples parse", () => {
  let dir: string;
  let restoreEnv: () => void;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-negation-examples-"));
    restoreEnv = isolateGatewayState(dir);
  });

  afterEach(() => {
    restoreEnv();
    process.exitCode = originalExitCode;
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(DOCUMENTED)("%s example reaches validation", async (cmd, args) => {
    // Assert on the FAILURE MODE, not on success: with no gateway running these cannot
    // complete, but they must fail for a connection reason — never for "unknown subcommand"
    // or "missing --service", which would mean the documented syntax is wrong.
    const err = await captureError(cmd, [...args]);
    // NEGATIVE: it must not fail on syntax.
    expect(err).not.toMatch(/Unknown people subcommand/i);
    expect(err).not.toMatch(/Missing --service/i);
    // POSITIVE: it must have got PAST validation and reached the IPC layer. Without this the
    // test passes vacuously if a command ever swallows a bad flag and returns early — two
    // `not.toMatch` assertions are both satisfied by an empty string.
    expect(err).toMatch(/gateway is not running|GatewayNotRunning/i);
  });
});
