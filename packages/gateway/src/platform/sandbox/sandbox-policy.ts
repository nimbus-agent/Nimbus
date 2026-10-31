import { parseNetworkEntry, type SandboxPermissions } from "@nimbus-dev/registry-format";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { isValidWildcardHost } from "./net-wildcard-hosts.ts";

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
  /**
   * The `permissions.network` entries the OWNER typed (a stored connector URL, a `--net`), the only
   * ones a runner may let resolve to a private or loopback address. Set only by gateway code from
   * the owner's settings, never read from a manifest file.
   */
  readonly ownerConfiguredNetwork?: readonly string[];
  /**
   * True when the policy came from a first-party manifest (`manifestForFirstParty`). Selects the
   * first-party column of the address rules. Set only by gateway code, never read from a manifest
   * file.
   */
  readonly firstPartyPolicy?: boolean;
  /**
   * Wildcard host patterns a first-party connector may reach, from the table in
   * `first-party-manifests.ts`. Only the Linux runner reads them. Set only by gateway code,
   * never read from a manifest file.
   */
  readonly firstPartyWildcardHosts?: readonly string[];
}

/** The single manifest -> policy derivation. `wrapServerSpec` is its only production caller. */
export function policyFromManifest(manifest: ExtensionManifest): SandboxPolicy {
  return {
    id: manifest.id,
    permissions: manifest.permissions,
    ...(manifest.ownerConfiguredNetwork === undefined
      ? {}
      : { ownerConfiguredNetwork: manifest.ownerConfiguredNetwork }),
    ...(manifest.firstPartyPolicy === true ? { firstPartyPolicy: true } : {}),
    ...(manifest.firstPartyWildcardHosts === undefined
      ? {}
      : { firstPartyWildcardHosts: manifest.firstPartyWildcardHosts }),
  };
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

/**
 * What the Linux wrapper needs from the gateway's environment and a child never gets. The allowlist
 * in `extensionProcessEnv` (I1) rightly drops both, and that dropped the helper override: a gateway
 * that saw a helper reported per-host, while its wrapper found none and gave the child the whole
 * internet. The wrapper strips them from the child's environment. Not on Windows, where `win32.ts`
 * reads the same override and its e2e tests rely on a helper copied beside the runtime instead.
 */
const LINUX_WRAPPER_ONLY_ENV = ["NIMBUS_SANDBOX_HELPER_PATH", "XDG_RUNTIME_DIR"] as const;

/** Whether a child under this policy has any network to reach. Wildcards alone count. */
export function declaresNetwork(policy: SandboxPolicy): boolean {
  return policy.permissions.network.length > 0 || (policy.firstPartyWildcardHosts?.length ?? 0) > 0;
}

/**
 * The distinct TCP ports a network list declares, ascending: the whole of what the macOS profile
 * enforces (`darwin.ts`), and what a macOS consent prompt has to name. A bare host is 443. An entry
 * whose port is not an integer in 1..65535 contributes nothing, so it opens nothing.
 */
export function declaredNetworkPorts(network: readonly string[]): number[] {
  const ports = new Set<number>();
  for (const entry of network) {
    const { port } = parseNetworkEntry(entry);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export function isSandboxWrapperOnlyEnv(key: string): boolean {
  return (LINUX_WRAPPER_ONLY_ENV as readonly string[]).includes(key);
}

export function sandboxWrapperOnlyEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform !== "linux") return {};
  const out: Record<string, string> = {};
  for (const key of LINUX_WRAPPER_ONLY_ENV) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new TypeError(`${what} must be an array of strings`);
  }
  return v as string[];
}

function wildcardPatterns(v: unknown): string[] {
  const patterns = strings(v, "policy.firstPartyWildcardHosts");
  const bad = patterns.find((p) => !isValidWildcardHost(p));
  if (bad !== undefined) {
    throw new TypeError("policy.firstPartyWildcardHosts holds a pattern that is not valid");
  }
  return patterns;
}

function booleanField(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") {
    throw new TypeError(`${what} must be a boolean`);
  }
  return v;
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
    ...(o["ownerConfiguredNetwork"] === undefined
      ? {}
      : {
          ownerConfiguredNetwork: strings(
            o["ownerConfiguredNetwork"],
            "policy.ownerConfiguredNetwork",
          ),
        }),
    ...(o["firstPartyPolicy"] === undefined
      ? {}
      : { firstPartyPolicy: booleanField(o["firstPartyPolicy"], "policy.firstPartyPolicy") }),
    ...(o["firstPartyWildcardHosts"] === undefined
      ? {}
      : { firstPartyWildcardHosts: wildcardPatterns(o["firstPartyWildcardHosts"]) }),
  };
}
