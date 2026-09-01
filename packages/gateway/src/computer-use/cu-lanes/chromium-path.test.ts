import { describe, expect, test } from "bun:test";
import { type ChromiumEnv, chromiumCandidates, resolveChromiumPathWith } from "./chromium-path.ts";

/** A fully-populated Windows environment. Every candidate path is then absolute and distinct. */
const WIN_ENV: ChromiumEnv = {
  programFiles: "C:\\Program Files",
  programFilesX86: "C:\\Program Files (x86)",
  localAppData: "C:\\Users\\alice\\AppData\\Local",
  home: "C:\\Users\\alice",
};
const POSIX_ENV: ChromiumEnv = {
  programFiles: undefined,
  programFilesX86: undefined,
  localAppData: undefined,
  home: "/home/alice",
};
/**
 * The roots `chromiumCandidates` falls back to when `%PROGRAMFILES%`/`%PROGRAMFILES(X86)%` are
 * unset. Used as INPUT, never in an assertion — see the fallback test for why a literal Windows
 * path in an assertion is a host-dependent test rather than a code test.
 */
const WINDOWS_DEFAULT_ROOTS: ChromiumEnv = {
  programFiles: "C:\\Program Files",
  programFilesX86: "C:\\Program Files (x86)",
  localAppData: undefined,
  home: POSIX_ENV.home,
};

describe("chromiumCandidates", () => {
  test("Windows prefers Chrome over Edge, and lists the per-user install", () => {
    // Edge ships on every stock Windows box, so a naive order would hand every Windows user Edge
    // even when they have Chrome. The per-user `%LOCALAPPDATA%` install is the DEFAULT when Chrome
    // is installed without admin rights, so omitting it would miss a large share of real machines.
    const c = chromiumCandidates("win32", WIN_ENV);
    const firstEdge = c.findIndex((p) => p.includes("msedge"));
    const lastChrome = c.reduce((acc, p, i) => (p.includes("chrome.exe") ? i : acc), -1);
    expect(lastChrome).toBeGreaterThan(-1);
    expect(firstEdge).toBeGreaterThan(lastChrome);
    // A separator-free fragment: "AppData\\Local" happens to survive because it sits inside ONE
    // `join` argument, but relying on that makes the test one refactor away from host-dependent.
    expect(c.some((p) => p.includes("AppData"))).toBe(true);
  });

  test("Windows falls back to the standard roots when the env vars are ABSENT", () => {
    // Exercised on every runner, which is the point of taking `env` as a parameter: as inline
    // `process.env[...] ?? "..."` these fallbacks were unreachable on Windows and the env side was
    // unreachable everywhere else.
    //
    // Proven by EQUALITY against an env that sets those roots explicitly, rather than by asserting
    // a literal prefix. `join` inserts the HOST separator, so `join("C:\\Program Files",
    // "Google\\Chrome\\…")` is `C:\Program Files\Google\…` on Windows and
    // `C:\Program Files/Google\…` on Linux — a `toContain("C:\\Program Files\\Google")` assertion
    // therefore passes on a Windows dev box and fails on the Linux CI leg. Comparing two calls to
    // the same pure function sidesteps the separator entirely.
    expect(chromiumCandidates("win32", POSIX_ENV)).toEqual(
      chromiumCandidates("win32", WINDOWS_DEFAULT_ROOTS),
    );
    // …and the fallback roots really are the Program Files pair, asserted without a separator.
    expect(chromiumCandidates("win32", POSIX_ENV)[0]).toContain("Program Files");
    expect(chromiumCandidates("win32", POSIX_ENV)[1]).toContain("Program Files (x86)");
  });

  test("an absent %LOCALAPPDATA% yields an EMPTY candidate, never a relative one", () => {
    // A relative path would be existence-checked against the gateway's cwd — a different file than
    // the one the name implies. The empty string is skipped by the resolver instead.
    expect(chromiumCandidates("win32", POSIX_ENV)).toContain("");
    expect(chromiumCandidates("win32", WIN_ENV)).not.toContain("");
  });

  test("macOS includes the per-user Applications directory, built from home", () => {
    const c = chromiumCandidates("darwin", { ...POSIX_ENV, home: "/Users/alice" });
    expect(c).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    // Asserted on SEGMENTS, not a separator-joined prefix: this function is pure over its
    // arguments, so a Windows runner evaluates the `darwin` branch too — and `join` there renders
    // `\Users\alice\Applications\…`. A `startsWith("/Users/alice/Applications/")` assertion passes
    // on macOS/Linux and fails on Windows, testing the host rather than the code.
    const perUser = c.find((p) => p.includes("Applications") && p.includes("alice"));
    expect(perUser).toBeDefined();
    expect(perUser).toContain("Google Chrome.app");
  });

  test("Linux lists the common package layouts, Edge last", () => {
    const c = chromiumCandidates("linux", POSIX_ENV);
    expect(c[0]).toBe("/usr/bin/google-chrome");
    expect(c).toContain("/snap/bin/chromium");
    expect(c[c.length - 1]).toBe("/usr/bin/microsoft-edge");
  });

  test("an unrecognised platform yields NOTHING rather than guessing a layout", () => {
    expect(chromiumCandidates("aix", POSIX_ENV)).toEqual([]);
  });
});

describe("resolveChromiumPathWith", () => {
  const probe = (over: Partial<Parameters<typeof resolveChromiumPathWith>[0]> = {}) =>
    resolveChromiumPathWith({
      platform: "linux",
      envOverride: undefined,
      env: POSIX_ENV,
      exists: () => false,
      ...over,
    });

  test("returns the first CANDIDATE that exists, in preference order", () => {
    const candidates = chromiumCandidates("linux", POSIX_ENV);
    const probed: string[] = [];
    const got = probe({
      exists: (p) => {
        probed.push(p);
        return p === candidates[2];
      },
    });
    expect(got).toBe(candidates[2] as string);
    // The first two must be PROBED and rejected, not skipped.
    expect(probed.slice(0, 3)).toEqual([
      candidates[0] as string,
      candidates[1] as string,
      candidates[2] as string,
    ]);
  });

  test("resolves a Windows install without running on Windows", () => {
    const want = chromiumCandidates("win32", WIN_ENV)[0] as string;
    expect(probe({ platform: "win32", env: WIN_ENV, exists: (p) => p === want })).toBe(want);
  });

  test("returns null when nothing is installed — the gate refuses BEFORE consent on this", () => {
    expect(probe()).toBeNull();
  });

  test("an unknown platform resolves nothing rather than throwing", () => {
    expect(probe({ platform: "aix", exists: () => true })).toBeNull();
  });

  test("the env override WINS over an installed candidate", () => {
    expect(probe({ envOverride: "/opt/custom/chrome", exists: () => true })).toBe(
      "/opt/custom/chrome",
    );
  });

  test("a RELATIVE env override is refused, never resolved against the gateway's cwd", () => {
    // `exec-policy.ts`'s reasoning: the gateway's working directory is not the caller's, so
    // resolving would silently select a real file that is not the one the user named.
    expect(probe({ envOverride: "./chrome", exists: () => true })).toBeNull();
  });

  test("an env override that does not exist is refused, and does NOT fall back to a candidate", () => {
    // Falling back would silently ignore an explicit instruction and launch a different browser
    // than the one the operator configured.
    expect(
      probe({ envOverride: "/opt/missing/chrome", exists: (p) => p !== "/opt/missing/chrome" }),
    ).toBeNull();
  });

  test("an EMPTY env override is treated as unset, not as a refusal", () => {
    const first = chromiumCandidates("linux", POSIX_ENV)[0] as string;
    expect(probe({ envOverride: "", exists: () => true })).toBe(first);
  });

  test("an empty candidate is never probed", () => {
    // `%LOCALAPPDATA%` absent produces one; probing "" would existence-check the cwd.
    const probed: string[] = [];
    probe({
      platform: "win32",
      env: POSIX_ENV,
      exists: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).not.toContain("");
  });
});
