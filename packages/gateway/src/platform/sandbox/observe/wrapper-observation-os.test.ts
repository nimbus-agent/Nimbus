/**
 * The whole Windows/macOS observation path on a real OS: the real `runSandboxWrapper` (the
 * `sandbox-wrapper-real.ts` fixture, production dependencies), a real sandboxed child, the real
 * connection source, the real poller and the real resolver. The child connects to its one declared
 * host, `api.github.com:443`, and to an undeclared address on 443 (another public host's, resolved
 * here at runtime, never one of GitHub's); the window files must say `used api.github.com:443` and
 * `unmatched <that address>:443`, and never name the undeclared host.
 *
 * Windows runs where the helper is built (and fails loudly on CI without it); macOS runs on the
 * macOS CI leg. Both need the network.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SANDBOX_CWD_ENV,
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  SANDBOX_POLICY_ENV,
} from "../sandbox-policy.ts";

const IS_WIN = process.platform === "win32";
const IS_DARWIN = process.platform === "darwin";
const IS_CI = process.env["CI"] === "true";
const HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
const HELPER_READY = IS_WIN && existsSync(HELPER);
const RUNS = IS_DARWIN || (IS_WIN && (HELPER_READY || IS_CI));
const POLICY_ID = "nimbus.observe-wrapper-test";
const HOST = "api.github.com";
const FIXTURE = resolve(import.meta.dir, "../../../../test/fixtures/sandbox-wrapper-real.ts");
/** Hosts whose IPv4 address can stand for "undeclared": unrelated to GitHub. */
const OTHER_HOSTS = ["example.com", "www.wikipedia.org", "one.one.one.one"];

/**
 * Runs inside the sandbox. Opens both connections at once and holds each 2 s (eight 250 ms polls),
 * then writes what it saw to `argv[4]`, a file in the one directory it may write.
 */
const CHILD_SOURCE = `
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
const [host, ip, outFile] = process.argv.slice(2);
function open(target) {
  return new Promise((done) => {
    const s = connect({ host: target, port: 443 });
    const t = setTimeout(() => { s.destroy(); done({ ok: false, error: "timeout" }); }, 15000);
    s.once("connect", () => {
      const remote = s.remoteAddress;
      setTimeout(() => { clearTimeout(t); s.destroy(); done({ ok: true, remote }); }, 2000);
    });
    s.once("error", (e) => { clearTimeout(t); done({ ok: false, error: e.message }); });
  });
}
const [declared, other] = await Promise.all([open(host), open(ip)]);
writeFileSync(outFile, JSON.stringify({ declared, other }));
`;

async function undeclaredAddress(): Promise<string> {
  const github = new Set((await lookup(HOST, { all: true })).map((r) => r.address));
  for (const host of OTHER_HOSTS) {
    try {
      const { address } = await lookup(host, { family: 4 });
      if (!github.has(address)) return address;
    } catch {
      // The next candidate.
    }
  }
  throw new Error(`no undeclared IPv4 address found among ${OTHER_HOSTS.join(", ")}`);
}

type Entry = { o: string; h: string; p: number; n: number };

describe.skipIf(!RUNS)("the wrapper observes a real sandboxed child (Windows, macOS)", () => {
  if (IS_WIN && IS_CI && !HELPER_READY) {
    test("fails loudly instead of silently skipping when the helper is missing on CI", () => {
      throw new Error(
        `wrapper-observation-os: CI precondition unmet — helper not found at ${HELPER}. Build it ` +
          "with `bun run build:sandbox-helper:win32`.",
      );
    });
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "nimbus-observe-wrapper-"));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    if (IS_WIN) {
      spawnSync(HELPER, ["--delete-profile", `nimbus-ext-${POLICY_ID}`], { windowsHide: true });
    }
  });

  test("a declared host is used by name; an undeclared address is unmatched, by address only", async () => {
    const ip = await undeclaredAddress();
    const sandboxDir = join(work, "sandbox");
    const outDir = join(sandboxDir, "out");
    const obsDir = join(work, "observations");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(obsDir);
    const childPath = join(sandboxDir, "child.mjs");
    writeFileSync(childPath, CHILD_SOURCE);
    const report = join(outDir, "report.json");
    const bunDir = dirname(process.execPath);
    // macOS: bun reads its own home tree (~/.bun) at startup, not only the binary.
    const read = IS_DARWIN ? [sandboxDir, bunDir, dirname(bunDir)] : [sandboxDir];
    const policy = {
      id: POLICY_ID,
      permissions: { network: [`${HOST}:443`], filesystem: { read, write: [outDir] } },
    };
    const wrapper = Bun.spawn(
      [process.execPath, "--no-env-file", FIXTURE, process.execPath, childPath, HOST, ip, report],
      {
        env: {
          ...process.env,
          ...(IS_WIN ? { NIMBUS_SANDBOX_HELPER_PATH: HELPER } : {}),
          [SANDBOX_POLICY_ENV]: JSON.stringify(policy),
          [SANDBOX_CWD_ENV]: sandboxDir,
          [SANDBOX_OBSERVATION_FILE_ENV]: join(obsDir, "ext_observe.1000.deadbeef"),
          [SANDBOX_OBSERVATION_LABEL_ENV]: JSON.stringify({
            extensionId: "com.example.observe",
            version: "1.0.0",
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        timeout: 90_000,
      },
    );
    const [, stderr, code] = await Promise.all([
      new Response(wrapper.stdout).text(),
      new Response(wrapper.stderr).text(),
      wrapper.exited,
    ]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    // Premise: the child really reached both, or "unmatched" would be vacuous.
    const child = JSON.parse(readFileSync(report, "utf8")) as {
      declared: { ok: boolean; error?: string };
      other: { ok: boolean; error?: string };
    };
    expect(child.declared).toMatchObject({ ok: true });
    expect(child.other).toMatchObject({ ok: true });

    const files = readdirSync(obsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(obsDir, f), "utf8")) as Record<string, unknown>);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.every((f) => f["networkObserved"] === true)).toBe(true);
    const entries = files.flatMap((f) => f["entries"] as Entry[]);
    const lines = entries.map((e) => `${e.o} ${e.h}:${String(e.p)}`);
    expect(lines).toContain(`used ${HOST}:443`);
    expect(lines).toContain(`unmatched ${ip}:443`);
    // Never a name for what was not declared, and nothing used but the declared host.
    for (const e of entries) {
      if (e.o === "used") expect(e.h).toBe(HOST);
      for (const other of OTHER_HOSTS) expect(e.h).not.toBe(other);
    }
  }, 120_000);
});
