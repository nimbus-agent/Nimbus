import { join } from "node:path";

import type { DoctorVaultExec } from "./doctor-core.ts";

// ---------------------------------------------------------------------------
// `nimbus doctor --fix-keyring` (issue #1168)
//
// Ruling 16 supersedes the issue's own premise: the remedy `doctor` prints
// (`echo "" | gnome-keyring-daemon --unlock --components=secrets`) does NOT
// deterministically fail with `cannot open display`. A 55-trial container
// spike found the real defect is a ~1-in-40-to-50 D-Bus NAME-OWNERSHIP RACE
// between the unlocking daemon and the next Secret Service client — closed by
// polling ownership of `org.freedesktop.secrets`, not by waiting on file
// existence (which still raced 1/15) and not by hand-authoring keyring file
// content (`gnome-keyring-daemon` writes `login.keyring` + `user.keystore`
// itself, at 0600, with zero manual authoring needed). See
// `docs/superpowers/plans/2026-08-13-installer-download-capability.md` Task 8
// for the full trial data this sequence is transcribed from — later changes
// to the sequence below must stay consistent with that record.
//
// Two things gnome-keyring will NOT do for us (verified: a pre-loosened 0755
// directory / 0666 keyring were both silently accepted and served
// uncorrected), so this file does them explicitly:
//   - the `~/.local/share/keyrings` directory is forced to 0700
//   - the keyring files it creates are defensively re-asserted at 0600
//
// And the single most important behaviour: NO pre-existing keyring material
// is ever touched. Overwriting it would destroy every credential the user
// has stored — this repo already shipped one bug in this area (a cleanup
// trap that `rm -rf`'d an inherited `$GNUPGHOME` and destroyed a real
// keyring), so "never damage user key material" is the governing constraint
// here, and it is enforced broadly: not just an existing `login.keyring`,
// but any `*.keyring` collection or `default`-alias pointer already sitting
// in the keyrings directory (e.g. a user who has a non-default-named
// collection and no `login.keyring` at all) refuses the run too, before
// anything is written.
// ---------------------------------------------------------------------------

export interface FixKeyringDeps {
  readonly exec: DoctorVaultExec;
  readonly homeDir: () => string;
  readonly statMode: (p: string) => number | null;
  readonly mkdirMode: (p: string, mode: number) => void;
  readonly writeFileMode: (p: string, data: string, mode: number) => void;
  /**
   * Basenames only (no full paths); returns `[]` when `p` does not exist.
   * Optional so existing `FixKeyringDeps` producers built before B-2 (broader
   * pre-existing-collection detection) keep compiling; a caller that omits it
   * still gets the `login.keyring`-exact refusal check, just not the broader
   * `*.keyring`/`default`-alias sweep.
   */
  readonly listDir?: (p: string) => readonly string[];
}

export interface FixKeyringResult {
  readonly exit: number;
  readonly lines: readonly string[];
}

const KEYRINGS_DIR_MODE = 0o700;
const KEYRING_FILE_MODE = 0o600;

// Distinguishable from any real credential a user might store — this tool
// only ever stores/looks up/clears this exact marker, never a real secret.
const PROBE_LABEL = "nimbus-fix-keyring-check";
const PROBE_VALUE = "nimbus-fix-keyring-check-ok";

function keyringsDirFor(home: string): string {
  return join(home, ".local", "share", "keyrings");
}

function loginKeyringPathFor(home: string): string {
  return join(keyringsDirFor(home), "login.keyring");
}

/**
 * The verified minimal sequence from the Task 8 spike, transcribed exactly
 * (mode literals included) plus a defensive `chmod 0600` re-assertion on the
 * two files gnome-keyring writes, since gnome-keyring enforces neither mode
 * itself. Runs entirely inside one `dbus-run-session`.
 */
function buildFixScript(): string {
  return [
    'mkdir -p "$HOME/.local/share/keyrings"',
    `chmod ${KEYRINGS_DIR_MODE.toString(8)} "$HOME/.local/share/keyrings"`,
    "",
    "# Newline-terminated (blank) password on stdin. A truly empty stdin was",
    "# tested and always fails: the directory is created but login.keyring is",
    "# never written, and the daemon falls through to prompting.",
    'printf "\\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1',
    "",
    "# Load-bearing: poll ownership of org.freedesktop.secrets on the session",
    "# bus before touching Secret Service. Waiting on file existence instead",
    "# still raced 1/15 in testing -- the D-Bus name is the real sync point.",
    "j=0",
    "while [ $j -lt 100 ]; do",
    "  dbus-send --session --dest=org.freedesktop.DBus --print-reply \\",
    "    /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner \\",
    "    string:org.freedesktop.secrets >/dev/null 2>&1 && break",
    "  j=$((j + 1))",
    "  sleep 0.02",
    "done",
    "",
    "# gnome-keyring enforces no permissions on what it just wrote -- assert them.",
    `chmod ${KEYRING_FILE_MODE.toString(8)} "$HOME/.local/share/keyrings/login.keyring" 2>/dev/null || true`,
    `chmod ${KEYRING_FILE_MODE.toString(8)} "$HOME/.local/share/keyrings/user.keystore" 2>/dev/null || true`,
    "",
    "# Nothing short of a real store+lookup round-trip counts as verified.",
    `printf "%s" "${PROBE_VALUE}" | secret-tool store --label=${PROBE_LABEL} application ${PROBE_LABEL} key value`,
    `secret-tool lookup application ${PROBE_LABEL} key value`,
    `secret-tool clear application ${PROBE_LABEL} key value`,
  ].join("\n");
}

function verifiedFromOutput(result: { code: number | null; stdout: string }): boolean {
  if (result.code !== 0) return false;
  return result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(PROBE_VALUE);
}

const PLAN_LINES: readonly string[] = [
  "Plan: create ~/.local/share/keyrings if missing, and tighten its mode to 0700 either way " +
    "(gnome-keyring does not enforce this itself, so a pre-existing, loosely-permissioned " +
    "directory is retightened too).",
  "Plan: run gnome-keyring-daemon --unlock (blank password) inside a fresh D-Bus session.",
  "Plan: poll ownership of org.freedesktop.secrets before touching Secret Service (closes the creation race).",
  "Plan: re-assert 0600 on login.keyring / user.keystore (gnome-keyring does not enforce this itself).",
  "Plan: verify with a real secret-tool store + lookup + clear round-trip.",
];

/**
 * The binaries the fixer needs, and the Debian/Ubuntu package that provides
 * each — checked, and reported, BEFORE any filesystem mutation (never after
 * `mkdirMode`), so a box missing one of them is left untouched rather than
 * left with a freshly chmod'd, still-broken directory. `gnome-keyring-daemon`
 * is the component that actually creates the keyring and is routinely absent
 * on exactly the headless boxes #1168 is about; its own stderr is suppressed
 * inside the script (`>/dev/null 2>&1`, needed so the poll loop's noise
 * doesn't leak), so this precheck is the only place its absence surfaces.
 */
const REQUIRED_BINARIES: readonly { readonly bin: string; readonly debianPkg: string }[] = [
  { bin: "dbus-run-session", debianPkg: "dbus-x11" },
  { bin: "gnome-keyring-daemon", debianPkg: "gnome-keyring" },
  { bin: "secret-tool", debianPkg: "libsecret-tools" },
];

function missingBinaryLine(exec: DoctorVaultExec): string | null {
  const missing = REQUIRED_BINARIES.filter((r) => !exec.hasBinary(r.bin));
  if (missing.length === 0) return null;
  const bins = missing.map((m) => m.bin).join(", ");
  const pkgs = [...new Set(missing.map((m) => m.debianPkg))].join(" ");
  return (
    `[fail] --fix-keyring: missing required binaries: ${bins}. ` +
    `Install ${pkgs} (Debian/Ubuntu) or the equivalent packages for your distro.`
  );
}

/**
 * Finds a pre-existing keyring collection this run must not touch: an exact
 * `login.keyring`, or — since a user can have a non-default-named collection
 * with no `login.keyring` at all — any other `*.keyring` file or a `default`
 * alias pointer already sitting in the keyrings directory. Returns the path
 * found, or `null` if the directory is clear (including "does not exist").
 */
function existingKeyringPath(
  deps: FixKeyringDeps,
  keyringsDir: string,
  loginKeyring: string,
): string | null {
  if (deps.statMode(loginKeyring) !== null) {
    return loginKeyring;
  }
  if (deps.statMode(keyringsDir) === null) {
    return null;
  }
  for (const name of (deps.listDir ?? (() => []))(keyringsDir)) {
    if (name === "default" || name.endsWith(".keyring")) {
      return join(keyringsDir, name);
    }
  }
  return null;
}

/**
 * Creates and unlocks a fresh Linux Secret Service keyring for a headless
 * box, closing the D-Bus name-ownership race identified in the Task 8 spike.
 * Refuses unconditionally if any pre-existing keyring material is found.
 * Callers are responsible for the Linux-only gate — see `runFixKeyringCommand`.
 */
export function fixKeyring(deps: FixKeyringDeps, opts: { dryRun: boolean }): FixKeyringResult {
  const home = deps.homeDir();
  const keyringsDir = keyringsDirFor(home);
  const loginKeyring = loginKeyringPathFor(home);

  const existing = existingKeyringPath(deps, keyringsDir, loginKeyring);
  if (existing !== null) {
    return {
      exit: 2,
      lines: [
        `[fail] --fix-keyring: ${existing} already exists.`,
        "Refusing to touch it: overwriting an existing keyring would destroy every credential",
        "already stored in it. If you intend to reset it, back it up and remove it yourself",
        "first, then re-run: nimbus doctor --fix-keyring.",
      ],
    };
  }

  if (opts.dryRun) {
    return {
      exit: 0,
      lines: [...PLAN_LINES, "[ok] --fix-keyring: dry run — no changes were written."],
    };
  }

  const lines: string[] = [...PLAN_LINES];

  const missing = missingBinaryLine(deps.exec);
  if (missing !== null) {
    lines.push(missing);
    return { exit: 2, lines };
  }

  // Unconditional, matching the plan text and buildFixScript()'s own
  // `mkdir -p` + `chmod 700` above: gnome-keyring enforces no permissions
  // itself (a pre-loosened 0755 directory was silently accepted and served
  // uncorrected in the Task 8 spike), so a pre-existing keyrings directory
  // is retightened to 0700 here too, not just left alone. `mkdirMode`'s
  // production implementation is `mkdirSync(recursive) + chmodSync`, so this
  // is a no-op create + an idempotent chmod when the directory already
  // exists — one code path, agreeing with what the script does below.
  deps.mkdirMode(keyringsDir, KEYRINGS_DIR_MODE);

  const result = deps.exec.runQuery(["dbus-run-session", "--", "bash", "-c", buildFixScript()]);

  if (!verifiedFromOutput(result)) {
    lines.push(
      `[fail] --fix-keyring: keyring creation did not verify (exit ${String(result.code)}). ` +
        `${result.stderr.trim()}`.trim(),
    );
    return { exit: 2, lines };
  }

  lines.push(
    "[ok] --fix-keyring: keyring created and unlocked; verified with a live secret-tool store+lookup round-trip.",
  );
  lines.push(
    "Note: every future `nimbus start` still needs to run inside its own D-Bus session/unlock " +
      "(e.g. dbus-run-session -- bash -c 'echo \"\" | gnome-keyring-daemon --unlock --components=secrets; nimbus start') " +
      "— this command only removed the from-scratch creation race, not the ongoing session requirement.",
  );
  return { exit: 0, lines };
}

const NOT_APPLICABLE_LINE =
  "[ok] --fix-keyring: not applicable — the Linux Secret Service fix only applies on Linux.";

/**
 * Linux-only gate for `fixKeyring`. macOS/Windows use their native
 * credential stores (Keychain/DPAPI) and never reach the Secret Service
 * probe at all, so `--fix-keyring` is a no-op there, not an error.
 */
export function runFixKeyringCommand(
  osName: string,
  deps: FixKeyringDeps,
  opts: { dryRun: boolean },
): FixKeyringResult {
  if (osName !== "linux") {
    return { exit: 0, lines: [NOT_APPLICABLE_LINE] };
  }
  return fixKeyring(deps, opts);
}
