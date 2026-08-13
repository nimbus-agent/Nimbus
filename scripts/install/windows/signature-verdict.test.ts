import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pwsh = Bun.which("pwsh");
const skip = !pwsh;

const INSTALL_PS1 = join(import.meta.dir, "install.ps1");

// Windows-only production defect (windows-2022, released-install-smoke run
// 31735428461): Git for Windows bundles an MSYS2-compiled gpg.exe whose own
// "is this --homedir absolute" check only recognizes a leading "/" (POSIX
// form), so a Windows-style --homedir path was silently treated as relative
// and `--import` failed, discarded by the `*>$null` redirect. `--verify`
// then ran against an empty/unreachable keyring and VALIDSIG never appeared
// -- the pinned key comparison this file tests was never even reached in
// production. That path bug is fixed separately in install.ps1's
// Test-NimbusSignature (a relative --homedir + Push-Location to a known
// $Dir, which works under both a native Win32 gpg.exe and an
// MSYS-translated one). This file is the OTHER half: proving the VALIDSIG
// PARSING itself -- once gpg's status-fd output is actually flowing --
// picks the correct field and rejects an expired/revoked key.
//
// Deliberately NOT a true-positive test that runs real gpg end to end: the
// project has already refused a fingerprint-override seam for
// Test-NimbusSignature because it would compose with
// $env:NIMBUS_INSTALL_BASE_URL into a full verification bypass. This file
// instead unit-tests Resolve-SignatureVerdict -- a pure function with no
// gpg invocation, no network access, and no environment-variable-driven
// trust anchor -- extracted VERBATIM from install.ps1's own source text (see
// extractResolveSignatureVerdict below) so it can never silently drift from
// what production actually runs. Its $ExpectedFingerprint parameter is an
// ordinary function argument, not a bypassable seam: the one production call
// site (Test-NimbusSignature) always supplies the hardcoded
// $NimbusSigningFpr constant, never anything caller- or env-supplied.

/**
 * Pulls the literal `Resolve-SignatureVerdict` function body straight out of
 * install.ps1's real source text (brace-counted from its header to the
 * matching close) rather than a hand-maintained copy, so a future edit to
 * the real function is exactly what these tests exercise -- no separate
 * fixture to fall out of sync.
 */
function extractResolveSignatureVerdict(): string {
  const src = readFileSync(INSTALL_PS1, "utf8");
  const startMarker = "function Resolve-SignatureVerdict {";
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      "Resolve-SignatureVerdict not found in install.ps1 -- extraction marker drifted?",
    );
  }
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  if (depth !== 0) {
    throw new Error("Resolve-SignatureVerdict: unbalanced braces during extraction");
  }
  return src.slice(start, i);
}

type Verdict = { Valid: boolean; Reason: string | null; PrimaryFingerprint: string | null };

/**
 * Runs the extracted function body in a fresh pwsh process against a canned
 * array of gpg `--status-fd 1` lines, exactly as `Test-NimbusSignature`
 * would call it with `$out` (an array of lines with stderr already
 * discarded via `2>$null`, matching production).
 */
async function runVerdict(statusLines: string[], expectedFingerprint: string): Promise<Verdict> {
  const fnBody = extractResolveSignatureVerdict();
  const linesLiteral = statusLines.map((l) => `'${l.replace(/'/g, "''")}'`).join(",\n");
  const script = `
${fnBody}
$lines = @(
${linesLiteral}
)
$v = Resolve-SignatureVerdict -StatusLines $lines -ExpectedFingerprint '${expectedFingerprint}'
$v | ConvertTo-Json -Compress
`;
  const proc = Bun.spawn([pwsh ?? "pwsh", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`pwsh failed (exit ${exitCode}): ${stderr}`);
  }
  return parseVerdict(stdout.trim());
}

/**
 * `JSON.parse` returns `any`, which would silently defeat this file's
 * `Promise<Verdict>` return type even under strict mode (an `any` is
 * assignable to anything without complaint) -- exactly the gap CLAUDE.md's
 * "no `any` -- use `unknown` for external data" rule exists to close. `pwsh`
 * output is a subprocess boundary like any other: decode as `unknown` first,
 * then validate the three fields this file actually reads before
 * constructing a `Verdict`, so a malformed/unexpected shape fails loudly
 * here instead of silently propagating `undefined`s into assertions.
 */
function parseVerdict(raw: string): Verdict {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Resolve-SignatureVerdict output was not a JSON object: ${raw}`);
  }
  const { Valid, Reason, PrimaryFingerprint } = parsed as Record<string, unknown>;
  if (typeof Valid !== "boolean") {
    throw new Error(`Resolve-SignatureVerdict output has a non-boolean Valid: ${raw}`);
  }
  if (Reason !== null && typeof Reason !== "string") {
    throw new Error(`Resolve-SignatureVerdict output has an invalid Reason: ${raw}`);
  }
  if (PrimaryFingerprint !== null && typeof PrimaryFingerprint !== "string") {
    throw new Error(`Resolve-SignatureVerdict output has an invalid PrimaryFingerprint: ${raw}`);
  }
  return { Valid, Reason, PrimaryFingerprint };
}

const PINNED_FP = "5A20457CCD8B53FFAA945240886ADA6B487CAB6E";
const SUBKEY_FP = "C4F331E91827CF897C6C47EF156554654F4A0639";

// A REAL, captured `gpg --homedir <posix-path> --quiet --status-fd 1
// --verify SHA256SUMS.asc SHA256SUMS` run (2>$null, matching production)
// against the ACTUAL published v2.3.0 SHA256SUMS.asc and the real Nimbus
// signing key -- not a hand-written fixture. See win-gpg-verify-report.md
// for the full repro session.
const REAL_VALID_STATUS_LINES = [
  "[GNUPG:] NEWSIG",
  "[GNUPG:] KEY_CONSIDERED 5A20457CCD8B53FFAA945240886ADA6B487CAB6E 0",
  "[GNUPG:] SIG_ID p+52pzuh8NAChTE0npJ/K1R5Tlw 2026-08-13 1786648723",
  "[GNUPG:] GOODSIG 156554654F4A0639 Nimbus Agent Release Signing <release@nimbus-agent.dev>",
  `[GNUPG:] VALIDSIG ${SUBKEY_FP} 2026-08-13 1786648723 0 4 0 22 10 00 ${PINNED_FP}`,
  "[GNUPG:] KEY_CONSIDERED 5A20457CCD8B53FFAA945240886ADA6B487CAB6E 0",
  "[GNUPG:] TRUST_UNDEFINED 0 pgp",
];

test.skipIf(skip)(
  "accepts a real, valid VALIDSIG line and reads the PRIMARY (last-field) fingerprint",
  async () => {
    const verdict = await runVerdict(REAL_VALID_STATUS_LINES, PINNED_FP);
    expect(verdict.Valid).toBe(true);
    expect(verdict.Reason).toBe(null);
    expect(verdict.PrimaryFingerprint).toBe(PINNED_FP);
  },
);

test.skipIf(skip)(
  "does NOT match when the pinned fingerprint sits at field 3 (signing subkey) but not the last field",
  async () => {
    // Construct a VALIDSIG line where the SIGNING-SUBKEY field (field 3) is
    // the pinned fingerprint, but the PRIMARY (last) field is a different,
    // decoy fingerprint. A naive `-match "VALIDSIG $fp"` substring/anchor
    // implementation would incorrectly treat this as a match (it only
    // inspects a prefix of the line); Resolve-SignatureVerdict must not.
    const decoyPrimary = "1111111111111111111111111111111111111111";
    const lines = [
      `[GNUPG:] VALIDSIG ${PINNED_FP} 2026-08-13 1786648723 0 4 0 22 10 00 ${decoyPrimary}`,
    ];
    const verdict = await runVerdict(lines, PINNED_FP);
    expect(verdict.Valid).toBe(false);
    expect(verdict.Reason).toBe("no-match");
    expect(verdict.PrimaryFingerprint).toBe(decoyPrimary);
  },
);

test.skipIf(skip)(
  "rejects EXPKEYSIG even when the primary fingerprint matches (expired key)",
  async () => {
    const lines = [
      ...REAL_VALID_STATUS_LINES,
      `[GNUPG:] EXPKEYSIG ${SUBKEY_FP} Nimbus Agent Release Signing <release@nimbus-agent.dev>`,
    ];
    const verdict = await runVerdict(lines, PINNED_FP);
    expect(verdict.Valid).toBe(false);
    expect(verdict.Reason).toBe("expired-or-revoked");
  },
);

test.skipIf(skip)(
  "rejects REVKEYSIG even when the primary fingerprint matches (revoked key)",
  async () => {
    const lines = [
      ...REAL_VALID_STATUS_LINES,
      `[GNUPG:] REVKEYSIG ${SUBKEY_FP} Nimbus Agent Release Signing <release@nimbus-agent.dev>`,
    ];
    const verdict = await runVerdict(lines, PINNED_FP);
    expect(verdict.Valid).toBe(false);
    expect(verdict.Reason).toBe("expired-or-revoked");
  },
);

test.skipIf(skip)(
  "reports no-match with a null fingerprint when no VALIDSIG line ever appears (NO_PUBKEY case)",
  async () => {
    // This is exactly what the pre-fix Windows bug produced: --import failed
    // silently, --verify found no public key, and gpg emits NO_PUBKEY /
    // FAILURE instead of VALIDSIG.
    const lines = [
      "[GNUPG:] NEWSIG",
      `[GNUPG:] ERRSIG ${SUBKEY_FP} 22 10 00 1786648723 9 ${SUBKEY_FP}`,
      `[GNUPG:] NO_PUBKEY ${SUBKEY_FP}`,
      "[GNUPG:] FAILURE gpg-exit 33554433",
    ];
    const verdict = await runVerdict(lines, PINNED_FP);
    expect(verdict.Valid).toBe(false);
    expect(verdict.Reason).toBe("no-match");
    expect(verdict.PrimaryFingerprint).toBe(null);
  },
);

test.skipIf(skip)("rejects a VALIDSIG signed by a different, unpinned key", async () => {
  const otherFp = "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
  const lines = [`[GNUPG:] VALIDSIG ${otherFp} 2026-08-13 1786648723 0 4 0 22 10 00 ${otherFp}`];
  const verdict = await runVerdict(lines, PINNED_FP);
  expect(verdict.Valid).toBe(false);
  expect(verdict.Reason).toBe("no-match");
  expect(verdict.PrimaryFingerprint).toBe(otherFp);
});
