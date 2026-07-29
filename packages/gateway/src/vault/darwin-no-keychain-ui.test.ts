import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const DARWIN_VAULT = join(import.meta.dir, "darwin.ts");

/**
 * Issue #932: `nimbus init` hung forever on macOS because a locked keychain sent
 * `SecKeychainAddGenericPassword` into a synchronous XPC wait on a GUI
 * authorization dialog nobody could answer.
 *
 * The fix is structural — keychain user interaction is refused for the process —
 * so the guarantee has to be asserted structurally too. A behavioural test can
 * only observe it on a macOS runner with a locked keychain, so the source guard
 * below carries the invariant on every platform, and the darwin-only test proves
 * the real call actually works where it can run.
 */
describe("darwin vault refuses the keychain UI (issue #932)", () => {
  it("declares the SecKeychainSetUserInteractionAllowed symbol", () => {
    const src = readFileSync(DARWIN_VAULT, "utf8");
    expect(src).toContain("SecKeychainSetUserInteractionAllowed:");
  });

  it("actually CALLS it, not merely declares it", () => {
    const src = readFileSync(DARWIN_VAULT, "utf8");
    // Matching the call site, not the dlopen declaration or an import: a
    // declared-but-never-called symbol would leave the hang fully intact.
    expect(src).toContain("security.symbols.SecKeychainSetUserInteractionAllowed(0)");
  });

  it("invokes the denial at module scope, so no code path can precede it", () => {
    const lines = readFileSync(DARWIN_VAULT, "utf8").split(/\r?\n/);
    // A bare, unindented call is module-level; inside a method it would be
    // indented and could be bypassed by whichever keychain call ran first.
    // Asserting over the matching lines rather than the whole file keeps a
    // failure readable instead of dumping 300 lines of source.
    const moduleLevel = lines.filter((l) => l === "denyKeychainUserInteraction();");
    expect(moduleLevel).toEqual(["denyKeychainUserInteraction();"]);
  });

  it("passes 0 (false) and never 1 — passing true would restore the hang", () => {
    const src = readFileSync(DARWIN_VAULT, "utf8");
    expect(src).not.toContain("SecKeychainSetUserInteractionAllowed(1)");
  });

  it.skipIf(platform() !== "darwin")(
    "sets user interaction to false against the real Security.framework",
    async () => {
      // Proves the FFI declaration is ABI-correct: a wrong signature would throw
      // or return a non-zero OSStatus here. errSecSuccess is 0.
      const { dlopen, FFIType } = await import("bun:ffi");
      // Reuse the production constant rather than repeating the path here.
      const { SECURITY_FRAMEWORK_PATH } = await import("./darwin.ts");
      const security = dlopen(SECURITY_FRAMEWORK_PATH, {
        SecKeychainSetUserInteractionAllowed: { args: [FFIType.u8], returns: FFIType.int32_t },
      });
      expect(security.symbols.SecKeychainSetUserInteractionAllowed(0)).toBe(0);
      // Leave the process as the gateway would have it.
      security.symbols.SecKeychainSetUserInteractionAllowed(0);
    },
  );

  it.skipIf(platform() !== "darwin")(
    "importing the darwin vault does not hang and yields a usable instance",
    async () => {
      const { DarwinKeychainVault } = await import("./darwin.ts");
      const root = join(import.meta.dir, "__nonexistent_probe_dir__");
      const vault = new DarwinKeychainVault({
        configDir: root,
        dataDir: root,
        logDir: root,
        socketPath: join(root, "sock"),
        extensionsDir: root,
        tempDir: root,
      });
      // listKeys reads the on-disk index only — no keychain call, so this is safe
      // even on a locked-keychain runner and still proves construction works.
      expect(await vault.listKeys()).toEqual([]);
    },
  );
});
