// Composition: the env `nimbus start` hands the gateway decides the profile SOURCE the gateway
// records, and only a marker/default source lets doctor and `config explain` warn that a later
// `nimbus profile switch` needs a restart. The CLI half (`spawnGateway`) runs with an injected spawn
// so the exact child env is captured; the gateway half resolves from that env.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SpawnOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorPrintProfile } from "../../../../cli/src/commands/doctor-core.ts";
import { spawnGateway } from "../../../../cli/src/lib/spawn-gateway.ts";
import type { CliPlatformPaths } from "../../../../cli/src/paths.ts";
import { resolveActiveProfile } from "../../../src/config/active-profile.ts";
import { explainConfig, restartWouldSwitch } from "../../../src/config/config-explain.ts";
import { LayeredConfig } from "../../../src/config/layered-config.ts";

let root: string;
let savedProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-spawn-restart-"));
  savedProfile = process.env["NIMBUS_PROFILE"];
  delete process.env["NIMBUS_PROFILE"];
});

afterEach(() => {
  if (savedProfile === undefined) delete process.env["NIMBUS_PROFILE"];
  else process.env["NIMBUS_PROFILE"] = savedProfile;
  rmSync(root, { recursive: true, force: true });
});

function paths(): CliPlatformPaths {
  const configDir = join(root, "config");
  const logDir = join(root, "logs");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const other = join(root, "unused");
  return {
    configDir,
    logDir,
    dataDir: other,
    socketPath: join(other, "sock"),
    extensionsDir: other,
    tempDir: other,
    sandboxDir: other,
  };
}

/** The env `spawnGateway` would hand the daemon, captured from an injected spawn. */
async function childEnv(p: CliPlatformPaths): Promise<NodeJS.ProcessEnv> {
  let captured: NodeJS.ProcessEnv | undefined;
  await spawnGateway(
    p,
    {},
    {
      resolveLaunch: () => ({ ok: true, cmd: ["gateway-bin"], cwd: root }),
      spawn: (_cmd: string, _args: readonly string[], options: SpawnOptions) => {
        captured = options.env;
        return { pid: 1, unref: () => {} };
      },
      platform: "linux",
    },
  );
  return captured ?? {};
}

describe("nimbus start + nimbus profile switch", () => {
  test("a marker-started gateway resolves source 'marker', and a later switch is flagged", async () => {
    const p = paths();
    writeFileSync(join(p.configDir, ".nimbus-profile"), "work\n");
    const env = await childEnv(p);
    const profile = resolveActiveProfile({ configDir: p.configDir, env: (k) => env[k] });
    expect(profile).toEqual({ name: "work", source: "marker" });

    // `nimbus profile switch home` while that gateway keeps running.
    writeFileSync(join(p.configDir, ".nimbus-profile"), "home\n");
    const reader = new LayeredConfig({ configDir: p.configDir, profile });
    expect(restartWouldSwitch(profile.source, profile.name, reader.markerProfile())).toBe(true);
    expect(explainConfig(reader, "a.b", () => undefined).notes).toContain(
      'profile switched to "home" on disk; restart the gateway to apply',
    );
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    let exit: number;
    try {
      exit = doctorPrintProfile({
        runningProfile: profile.name,
        runningProfileSource: profile.source,
        markerProfile: reader.markerProfile(),
        layers: [],
      });
    } finally {
      console.log = log;
    }
    expect(exit).toBe(1);
    expect(lines.join(" ")).toContain('marker says "home" but the gateway runs "work"');
  });

  test("an env-started gateway resolves source 'env' and a marker switch is not flagged", async () => {
    const p = paths();
    writeFileSync(join(p.configDir, ".nimbus-profile"), "work\n");
    process.env["NIMBUS_PROFILE"] = "shell";
    const env = await childEnv(p);
    const profile = resolveActiveProfile({ configDir: p.configDir, env: (k) => env[k] });
    expect(profile).toEqual({ name: "shell", source: "env" });
    expect(restartWouldSwitch(profile.source, profile.name, "work")).toBe(false);
  });
});
