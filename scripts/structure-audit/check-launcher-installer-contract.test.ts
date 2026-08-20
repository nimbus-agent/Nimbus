import { expect, test } from "bun:test";

import { installerSuffixes, parseVendoredSuffixes } from "./check-launcher-installer-contract.ts";

// A backtick cannot be written inside a backtick-delimited template literal, and the
// fixture must contain one (the vendored file uses `String.raw`). Build it by
// concatenation rather than fighting the escaping.
const BT = "`";
const GOOD = [
  `export const INSTALLER_WIN32_SUFFIX = String.raw${BT}\\Programs\\Nimbus\\bin${BT};`,
  `export const INSTALLER_POSIX_SUFFIX = "/.local/bin";`,
].join("\n");

test("parses both vendored suffixes", () => {
  expect(parseVendoredSuffixes(GOOD)).toEqual({
    win32: String.raw`\Programs\Nimbus\bin`,
    posix: "/.local/bin",
  });
});

test("a renamed constant yields null rather than a wrong value", () => {
  // A rename must FAIL the audit loudly, not silently match nothing and pass.
  const renamed = GOOD.replace("INSTALLER_POSIX_SUFFIX", "INSTALLER_UNIX_SUFFIX");
  expect(parseVendoredSuffixes(renamed).posix).toBeNull();
  // The win32 half is untouched, so a partial rename is still detectable.
  expect(parseVendoredSuffixes(renamed).win32).toBe(String.raw`\Programs\Nimbus\bin`);
});

test("a reshaped literal yields null — the parser is form-sensitive by design", () => {
  // `String.raw` -> a plain double-quoted string would silently change the value's
  // escaping semantics, so the parser refuses to match it rather than guess.
  const reshaped = GOOD.replace(
    `String.raw${BT}\\Programs\\Nimbus\\bin${BT}`,
    `"\\\\Programs\\\\Nimbus\\\\bin"`,
  );
  expect(parseVendoredSuffixes(reshaped).win32).toBeNull();
});

test("installerSuffixes derives from resolveInstallDir, not a second hardcoded copy", () => {
  expect(installerSuffixes()).toEqual({
    win32: String.raw`\Programs\Nimbus\bin`,
    posix: "/.local/bin",
  });
});

test("the vendored fixture matches what the installer builds today", () => {
  // The end-to-end assertion the CI jobs run. Kept here too so a change to
  // `resolveInstallDir` fails a local `bun test` immediately, not only on CI.
  const installer = installerSuffixes();
  expect(parseVendoredSuffixes(GOOD)).toEqual({
    win32: installer.win32,
    posix: installer.posix,
  });
});
