import { describe, expect, test } from "bun:test";
import { applyNormalization, NORMALIZATION_RULES } from "./normalize.ts";

const ctx = {
  tmpDirPrefix: "/tmp/cast-driver-xyz",
  homePrefix: "/home/runner",
};

function n(input: string): string {
  return applyNormalization(new TextEncoder().encode(input), ctx);
}

describe("applyNormalization", () => {
  test("UTF-8 decode replaces invalid bytes with U+FFFD", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0xff, 0x0a]);
    expect(applyNormalization(bytes, ctx)).toBe("hi�\n");
  });

  test("strips ANSI CSI color sequences", () => {
    expect(n("\x1b[31mred\x1b[0m\n")).toBe("red\n");
  });

  test("strips ANSI cursor-position sequences", () => {
    expect(n("\x1b[2J\x1b[H\n")).toBe("\n");
  });

  test(String.raw`normalizes \r\n to \n`, () => {
    expect(n("line1\r\nline2\r\n")).toBe("line1\nline2\n");
  });

  test(String.raw`resolves carriage returns within a line (keeps substring after last \r)`, () => {
    expect(n("loading...\rdone\n")).toBe("done\n");
  });

  test(String.raw`trailing lone \r at EOF normalizes to \n`, () => {
    expect(n("hello\r")).toBe("hello\n");
  });

  test("strips trailing whitespace per line", () => {
    expect(n("line one   \nline two\t\t\n")).toBe("line one\nline two\n");
  });

  test("replaces tmp dir prefix with <TMP>", () => {
    expect(n("wrote /tmp/cast-driver-xyz/foo\n")).toBe("wrote <TMP>/foo\n");
  });

  test("replaces home prefix with <HOME>", () => {
    expect(n("reading /home/runner/.nimbus/config.toml\n")).toBe(
      "reading <HOME>/.nimbus/config.toml\n",
    );
  });

  test("replaces ISO-8601 timestamps with <TS>", () => {
    expect(n("at 2026-05-14T10:45:14.123Z\n")).toBe("at <TS>\n");
    expect(n("at 2026-05-14T10:45:14Z\n")).toBe("at <TS>\n");
    expect(n("at 2026-05-14T10:45:14+02:00\n")).toBe("at <TS>\n");
  });

  test("replaces 13-digit epoch ms with <TS> but leaves shorter numbers alone", () => {
    expect(n("ts=1700000000000\n")).toBe("ts=<TS>\n");
    expect(n("PR #1234\n")).toBe("PR #1234\n");
    expect(n("port 65535\n")).toBe("port 65535\n");
    expect(n("issue 12345678\n")).toBe("issue 12345678\n");
  });

  test("replaces UUIDs with <ID>", () => {
    expect(n("uuid=550e8400-e29b-41d4-a716-446655440000\n")).toBe("uuid=<ID>\n");
  });

  test("replaces ULIDs with <ID>", () => {
    expect(n("ulid=01ARZ3NDEKTSV4RRFFQ69G5FAV\n")).toBe("ulid=<ID>\n");
  });

  test("replaces labelled session/stream/PID with <ID>", () => {
    expect(n("session_id=abc12345\n")).toBe("session_id=<ID>\n");
    expect(n("streamId=stream-xyz\n")).toBe("streamId=<ID>\n");
    expect(n("pid=42\n")).toBe("pid=<ID>\n");
    expect(n("PID 12345\n")).toBe("PID <ID>\n");
  });

  test("does NOT replace bare hex (could be legitimate)", () => {
    expect(n("deadbeef\n")).toBe("deadbeef\n");
  });

  test("replaces nimbus/Bun/Node version strings", () => {
    expect(n("nimbus v0.1.0\n")).toBe("nimbus <VERSION>\n");
    expect(n("Bun v1.2.21\n")).toBe("Bun <VERSION>\n");
    expect(n("Bun v1.2.21-beta.1\n")).toBe("Bun <VERSION>\n");
    expect(n("Node v22.5.0\n")).toBe("Node <VERSION>\n");
  });

  test("replaces git SHAs (7-40 hex chars)", () => {
    expect(n("sha=abc1234\n")).toBe("sha=<SHA>\n");
    expect(n("sha=0123456789abcdef0123456789abcdef01234567\n")).toBe("sha=<SHA>\n");
  });

  test("UUID rule runs before SHA rule (UUID hex blocks already gone)", () => {
    expect(n("550e8400-e29b-41d4-a716-446655440000\n")).toBe("<ID>\n");
  });

  test("idempotence: normalize(normalize(x)) === normalize(x)", () => {
    const input = "session_id=abc Bun v1.2.21 at 2026-05-14T10:00:00Z sha=deadbeef0\n";
    const once = n(input);
    const twice = applyNormalization(new TextEncoder().encode(once), ctx);
    expect(twice).toBe(once);
  });

  test("NORMALIZATION_RULES exports a non-empty readonly list", () => {
    expect(NORMALIZATION_RULES.length).toBeGreaterThanOrEqual(12);
  });
});

describe("placeholder path separators — cross-platform snapshot stability", () => {
  // The cast tripwire runs on ubuntu, but casts get recorded on whatever
  // machine a maintainer is using. A command that prints a path under the
  // harness tmpdir (`nimbus init` prints its repo root) is the one place where
  // the host's separator leaks into the transcript. These assert the two
  // recordings converge, which is what keeps the committed snapshot valid.
  const BS = String.fromCharCode(92);

  function nWin(input: string): string {
    return applyNormalization(new TextEncoder().encode(input), {
      tmpDirPrefix: ["C:", "Users", "dev", "AppData", "Local", "Temp", "cast-driver-xyz"].join(BS),
      homePrefix: ["C:", "Users", "dev"].join(BS),
    });
  }

  test("a Windows recording and a POSIX recording normalise identically", () => {
    const posix = n("Added /tmp/cast-driver-xyz/sample-repo to nimbus.toml (code indexing on).\n");
    const win = nWin(
      `Added C:${BS}Users${BS}dev${BS}AppData${BS}Local${BS}Temp${BS}cast-driver-xyz${BS}sample-repo to nimbus.toml (code indexing on).\n`,
    );
    expect(win).toBe(posix);
    expect(win).toBe("Added <TMP>/sample-repo to nimbus.toml (code indexing on).\n");
  });

  test("nested paths under the placeholder are fully normalised", () => {
    expect(
      nWin(
        `C:${BS}Users${BS}dev${BS}AppData${BS}Local${BS}Temp${BS}cast-driver-xyz${BS}a${BS}b${BS}c.ts\n`,
      ),
    ).toBe("<TMP>/a/b/c.ts\n");
  });

  test("the home placeholder gets the same treatment", () => {
    expect(nWin(`C:${BS}Users${BS}dev${BS}code${BS}proj\n`)).toBe("<HOME>/code/proj\n");
  });

  test("backslashes NOT attached to a placeholder are left alone", () => {
    // Markdown escapes and Windows paths the demo deliberately shows verbatim
    // must survive; the rule is scoped to the placeholder run only.
    expect(n(`a${BS}b not a path\n`)).toBe(`a${BS}b not a path\n`);
  });

  test("still idempotent with the new rule", () => {
    const once = nWin(
      `C:${BS}Users${BS}dev${BS}AppData${BS}Local${BS}Temp${BS}cast-driver-xyz${BS}x${BS}y\n`,
    );
    const twice = applyNormalization(new TextEncoder().encode(once), ctx);
    expect(twice).toBe(once);
  });
});

describe("tmp-prefix — the macOS /private alias", () => {
  // `/var` is a symlink to `/private/var` on macOS, so os.tmpdir() reports
  // `/var/folders/…` while a resolved path prints `/private/var/folders/…`.
  // Replacing only the unresolved prefix produced `/private<TMP>` and kept
  // `main` red on macOS alone, deterministically, for days.
  const macCtx = { tmpDirPrefix: "/var/folders/pd/abc123/T/harness", homePrefix: "/Users/runner" };
  const nMac = (s: string): string => applyNormalization(new TextEncoder().encode(s), macCtx);

  test("a RESOLVED macOS temp path normalises to <TMP>, not /private<TMP>", () => {
    expect(
      nMac("Added /private/var/folders/pd/abc123/T/harness/sample-repo to nimbus.toml\n"),
    ).toBe("Added <TMP>/sample-repo to nimbus.toml\n");
  });

  test("the UNRESOLVED form still normalises, so both spellings agree", () => {
    // Both must land on the same text or the snapshot depends on which form a
    // given command happened to print.
    expect(nMac("Added /var/folders/pd/abc123/T/harness/sample-repo to nimbus.toml\n")).toBe(
      "Added <TMP>/sample-repo to nimbus.toml\n",
    );
  });

  test("a macOS transcript matches the Linux one byte-for-byte", () => {
    // The actual regression: the committed snapshot is recorded on Linux, and
    // macOS must reproduce it exactly.
    const linux = applyNormalization(
      new TextEncoder().encode("Added /tmp/cast-driver-xyz/sample-repo to nimbus.toml\n"),
      ctx,
    );
    expect(
      nMac("Added /private/var/folders/pd/abc123/T/harness/sample-repo to nimbus.toml\n"),
    ).toBe(linux);
  });

  test("an unrelated /private path is untouched", () => {
    // The rule must key on the harness tmpdir, not on the literal "/private".
    expect(nMac("see /private/etc/hosts\n")).toBe("see /private/etc/hosts\n");
  });

  test("idempotent", () => {
    const once = nMac("Added /private/var/folders/pd/abc123/T/harness/x to nimbus.toml\n");
    expect(applyNormalization(new TextEncoder().encode(once), macCtx)).toBe(once);
  });
});
