import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { SandboxPermissions } from "../../extensions/permissions-validator.ts";

/**
 * What a sandbox runner needs to know to confine a process.
 *
 * Deliberately NOT an `ExtensionManifest`: the runners only ever read `.permissions` and `.id`,
 * and a one-shot execution has no manifest to offer. Keeping the input this narrow is what lets
 * a per-execution capability set reach the same three runners a connector uses.
 */
export interface SandboxPolicy {
  /** Naming key. The Windows AppContainer profile name derives from it; Linux/macOS ignore it. */
  readonly id: string;
  readonly permissions: SandboxPermissions;
  /**
   * One-shot executions only. Still NOT enforced by any runner, and still not an OS-level limit —
   * but the execution surface this field was reserved for now exists: `exec/exec-run.ts`
   * (`runConfined`) enforces the budget itself, killing the child on expiry (SIGTERM, escalating to
   * SIGKILL). A connector spawn ignores this field entirely.
   *
   * So a set value is a guarantee ONLY for a caller that routes through `runConfined`. Handing a
   * policy carrying `limits` to a runner directly still bounds nothing. Moving enforcement down to
   * the Windows Job Object the helper already assigns remains available as later hardening.
   */
  readonly limits?: { readonly wallClockMs?: number };
}

/** The single manifest -> policy derivation. `wrapServerSpec` is its only production caller. */
export function policyFromManifest(manifest: ExtensionManifest): SandboxPolicy {
  return { id: manifest.id, permissions: manifest.permissions };
}

/**
 * The wrapper wire: `wrapServerSpec` writes these two variables, `runSandboxWrapper` reads them.
 *
 * ONE definition each, because a producer and a consumer that separately hardcode the same string
 * literal are two copies that can drift, and the drift is invisible in the direction that matters:
 * the producer keeps setting a variable nobody reads, and the wrapper fails closed with
 * "<name> not set", which reads as a misconfigured environment rather than as a broken build.
 * The integration suite hand-sets these too, so nothing else in the tree asserts the two sides
 * agree — only sharing the constant does.
 */
export const SANDBOX_POLICY_ENV = "NIMBUS_SANDBOX_POLICY_JSON";
export const SANDBOX_CWD_ENV = "NIMBUS_SANDBOX_CWD";

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new TypeError(`${what} must be an array of strings`);
  }
  return v as string[];
}

/**
 * Parse the {@link SANDBOX_POLICY_ENV} payload into a policy, validating its runtime shape.
 *
 * `JSON.parse(...) as SandboxPolicy` was a lie the compiler could not catch: the value crosses a
 * process boundary, so it is `unknown` (non-negotiable 7) no matter who set it. The practical
 * failure it prevents is not a widened sandbox — a missing `permissions.network` made the runner
 * throw a raw `TypeError` deep inside `decideNetworkMode`, which is fail-closed but reports the
 * wrong thing. Validating here turns that into the wrapper's own named error, at the boundary
 * where the bad value actually entered.
 *
 * Only what a runner reads is validated, and every runner reads all of it: `id` (the Windows
 * profile name), `permissions.network` (the network mode) and both filesystem arrays (the bind /
 * ACL sets). `limits` is optional and enforced by nobody, so it is carried through unchecked.
 */
export function parseSandboxPolicy(json: string): SandboxPolicy {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("policy must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"] === "") {
    throw new TypeError("policy.id must be a non-empty string");
  }
  const perms = o["permissions"];
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    throw new TypeError("policy.permissions must be an object");
  }
  const p = perms as Record<string, unknown>;
  const fs = p["filesystem"];
  if (typeof fs !== "object" || fs === null || Array.isArray(fs)) {
    throw new TypeError("policy.permissions.filesystem must be an object");
  }
  const f = fs as Record<string, unknown>;
  return {
    id: o["id"],
    permissions: {
      network: strings(p["network"], "policy.permissions.network"),
      filesystem: {
        read: strings(f["read"], "policy.permissions.filesystem.read"),
        write: strings(f["write"], "policy.permissions.filesystem.write"),
      },
    },
    ...(typeof o["limits"] === "object" && o["limits"] !== null
      ? { limits: o["limits"] as NonNullable<SandboxPolicy["limits"]> }
      : {}),
  };
}
