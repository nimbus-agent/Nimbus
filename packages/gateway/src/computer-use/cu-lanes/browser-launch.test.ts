import { describe, expect, test } from "bun:test";
import type { CuBrowserLaunchPolicy } from "../cu-types.ts";
import {
  assertBrowserLaunchPolicy,
  buildChromiumLaunchPolicy,
  FORBIDDEN_LAUNCH_FLAGS,
} from "./browser-launch.ts";

const PROFILE = process.platform === "win32" ? "C:\\nimbus\\cu-profile" : "/var/nimbus/cu-profile";

function policy(over: Partial<CuBrowserLaunchPolicy> = {}): CuBrowserLaunchPolicy {
  return { ...buildChromiumLaunchPolicy({ profileDir: PROFILE }), ...over };
}

describe("buildChromiumLaunchPolicy", () => {
  test("the built policy passes its own assertion", () => {
    expect(
      assertBrowserLaunchPolicy(buildChromiumLaunchPolicy({ profileDir: PROFILE })),
    ).toBeNull();
  });

  test("--user-data-dir carries the profile directory verbatim", () => {
    const p = buildChromiumLaunchPolicy({ profileDir: PROFILE });
    expect(p.argv).toContain(`--user-data-dir=${PROFILE}`);
    expect(p.profileDir).toBe(PROFILE);
  });

  test("it never emits a flag its own assertion forbids", () => {
    // The two halves must agree: a builder that emitted a forbidden flag would make every session
    // refuse before consent, which reads as a configuration problem rather than a code defect.
    const p = buildChromiumLaunchPolicy({ profileDir: PROFILE });
    for (const arg of p.argv) {
      for (const forbidden of FORBIDDEN_LAUNCH_FLAGS) {
        expect(arg === forbidden || arg.startsWith(`${forbidden}=`)).toBe(false);
      }
    }
  });

  test("it is headless and asks for an EPHEMERAL debugging port", () => {
    const p = buildChromiumLaunchPolicy({ profileDir: PROFILE });
    expect(p.argv).toContain("--headless=new");
    expect(p.argv).toContain("--remote-debugging-port=0");
  });
});

describe("assertBrowserLaunchPolicy", () => {
  test("an EMPTY profile directory is refused — Chromium would use the owner's real profile", () => {
    // The worst outcome available on this lane, and one missing flag away: their cookies, their
    // logged-in sessions, their history.
    const out = assertBrowserLaunchPolicy(policy({ profileDir: "", argv: [] }));
    expect(out).toContain("real Chrome profile");
  });

  test("a RELATIVE profile directory is refused rather than resolved", () => {
    const out = assertBrowserLaunchPolicy(
      policy({ profileDir: "cu-profile", argv: ["--user-data-dir=cu-profile"] }),
    );
    expect(out).toContain("must be absolute");
  });

  test("a MISSING --user-data-dir is refused", () => {
    const out = assertBrowserLaunchPolicy(
      policy({ argv: ["--headless=new", "--remote-debugging-port=0"] }),
    );
    expect(out).toContain("exactly one --user-data-dir");
  });

  test("a DUPLICATE --user-data-dir is refused — Chromium takes the first and ignores the rest", () => {
    const out = assertBrowserLaunchPolicy(
      policy({
        argv: [
          "--remote-debugging-port=0",
          `--user-data-dir=${PROFILE}`,
          "--user-data-dir=/tmp/elsewhere",
        ],
      }),
    );
    expect(out).toContain("exactly one --user-data-dir");
  });

  test("a --user-data-dir that DISAGREES with profileDir is refused", () => {
    const out = assertBrowserLaunchPolicy(
      policy({ argv: ["--remote-debugging-port=0", "--user-data-dir=/tmp/elsewhere"] }),
    );
    expect(out).toContain("does not match the approved profile directory");
  });

  test.each(FORBIDDEN_LAUNCH_FLAGS.map((f) => [f]))("refuses %s", (flag) => {
    const out = assertBrowserLaunchPolicy(
      policy({
        argv: ["--remote-debugging-port=0", `--user-data-dir=${PROFILE}`, flag as string],
      }),
    );
    expect(out).toContain(flag as string);
  });

  test("refuses a forbidden flag written with a VALUE, not only bare", () => {
    // `--disable-features=IsolateOrigins,site-per-process` turns off site isolation while looking
    // like an unrelated tuning flag; an equality check would never see it.
    const out = assertBrowserLaunchPolicy(
      policy({
        argv: [
          "--remote-debugging-port=0",
          `--user-data-dir=${PROFILE}`,
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      }),
    );
    expect(out).toContain("--disable-features");
  });

  test("a FIXED debugging port is refused — any local process could drive that browser", () => {
    const out = assertBrowserLaunchPolicy(
      policy({ argv: [`--user-data-dir=${PROFILE}`, "--remote-debugging-port=9222"] }),
    );
    expect(out).toContain("ephemeral CDP port");
  });

  test("a MISSING debugging port is refused", () => {
    const out = assertBrowserLaunchPolicy(policy({ argv: [`--user-data-dir=${PROFILE}`] }));
    expect(out).toContain("ephemeral CDP port");
  });

  test("--no-sandbox is caught even when it is the LAST flag", () => {
    // Red-proved shape: an early-return scan that stopped at the first interesting flag would let
    // a trailing one through, and appending is exactly how such a flag gets added.
    const built = buildChromiumLaunchPolicy({ profileDir: PROFILE });
    const out = assertBrowserLaunchPolicy({
      ...built,
      argv: [...built.argv, "--no-sandbox"],
    });
    expect(out).toContain("--no-sandbox");
  });
});
