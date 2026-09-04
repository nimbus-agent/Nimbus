// Helpers shared by the `phase3-<group>.ts` spawn modules.
//
// Split out of `phase3-config.ts` (1727 lines, 64 exports) so each cloud/domain group reads
// on its own. Note what did NOT get hoisted into a single copy: the file-local `wrap`
// delegation. I15/D10 accepts the `wrap` alias only in a file that ALSO declares it as a
// delegation to `wrapServerSpec`, precisely so that naming a function `wrap` cannot launder
// an unwrapped spec. Every module here that builds a spec therefore declares its own - this
// one included, since the `add*` helpers below build specs too.

import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ConnectorServiceId } from "../connector-catalog.ts";
import { type ConnectorSecretKeyOf, readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
}

// Vertex AI is regional; this is the default when the optional `gcp.region`
// config key is unset.
export const VERTEX_AI_DEFAULT_REGION = "us-central1";

/**
 * Inline argv flag-smuggling guard for the optional Vertex AI region before it
 * is interpolated into the spawned MCP's `VERTEX_AI_REGION` env and the per-region
 * network host (the gateway package cannot import `mcp-connectors/shared`). A value
 * that is empty, over-long, `-`-prefixed, or carries control characters is rejected
 * so the caller falls back to the safe default.
 */
export function isSafeRegion(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if ((value.codePointAt(i) ?? 0x20) < 0x20) {
      return false;
    }
  }
  return true;
}

/**
 * Shared argv flag-smuggling guard for host-identifier-style values (Snowflake
 * account identifiers, Power BI tenant ids, etc.) before they are interpolated
 * into URLs or spawned-MCP env vars. A value that is empty, over-long, `-`-prefixed,
 * or carries control characters is rejected so the caller noops.
 */
export function isSafeHostIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if ((value.codePointAt(i) ?? 0x20) < 0x20) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a per-tenant IMAP/SMTP port string into a valid TCP port, falling back
 * to `fallback` when empty or out of range. Mirrors the validator's 1..65535
 * bound so the spawned host:port network entry is always well-formed.
 */
export function imapPortOrDefault(raw: string, fallback: number): number {
  if (raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.trunc(n) : fallback;
}

/** Read + trim an optional connector secret, defaulting to "" when unset. */
export async function readSecret<S extends ConnectorServiceId>(
  vault: NimbusVault,
  serviceId: S,
  key: ConnectorSecretKeyOf<S>,
): Promise<string> {
  return (await readConnectorSecret(vault, serviceId, key))?.trim() ?? "";
}

export interface SimpleTokenSpec<S extends ConnectorServiceId> {
  /** Service id, used as the `servers` key, the manifest id, and the secret namespace. */
  readonly serviceId: S;
  /** MCP server script name passed to {@link connectorSpawn}. */
  readonly script: string;
  /** Vault secret suffix (e.g. `"token"`, `"api_key"`) — validated against the service. */
  readonly secretKey: ConnectorSecretKeyOf<S>;
  /** Environment variable name the spawned connector reads the secret from. */
  readonly envKey: string;
}

/**
 * Register a single-secret connector: read one token/key, noop when unset, then
 * wrap + register the spawn. Collapses the ~12 token-only connector bodies that
 * differ only in their service id / script / secret key / env var name.
 */
export async function addSimpleTokenServer<S extends ConnectorServiceId>(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
  spec: SimpleTokenSpec<S>,
): Promise<void> {
  const value = await readSecret(vault, spec.serviceId, spec.secretKey);
  if (value === "") {
    return;
  }
  servers[spec.serviceId] = wrap(
    {
      ...connectorSpawn(spec.script),
      env: extensionProcessEnv({ [spec.envKey]: value }),
    },
    spec.serviceId,
    sandboxCwd,
  );
}

/**
 * Register a local, no-network connector that reads files from a configured
 * directory: extend the first-party manifest's `filesystem.read` with the dir at
 * spawn time, noop when the dir is unset. Shared by the Tier-5 local connectors
 * (localdb, dataprofile, storybook) and great_expectations.
 */
export async function addDirManifestServer<S extends ConnectorServiceId>(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
  spec: SimpleTokenSpec<S>,
): Promise<void> {
  const dir = await readSecret(vault, spec.serviceId, spec.secretKey);
  if (dir === "") {
    return;
  }
  const base = manifestForFirstParty(spec.serviceId);
  const manifest = {
    ...base,
    permissions: {
      ...base.permissions,
      filesystem: {
        read: [...base.permissions.filesystem.read, dir],
        write: [...base.permissions.filesystem.write],
      },
    },
  };
  servers[spec.serviceId] = wrapServerSpec(
    {
      ...connectorSpawn(spec.script),
      env: extensionProcessEnv({ [spec.envKey]: dir }),
    },
    manifest,
    sandboxCwd,
  );
}

export interface AwsCreds {
  /** Whether enough of the AWS credential set is present to spawn. */
  readonly ok: boolean;
  /** The configured default region ("" when unset) — needed for regional hosts. */
  readonly region: string;
  /** The connector env subset (only the keys that were actually configured). */
  readonly env: Record<string, string>;
}

/**
 * Read the shared AWS credential set (key / secret / region / profile) once and
 * build the connector env subset. Reused by the AWS-family connectors (aws,
 * athena, cloudwatch, sagemaker) that all authenticate the same way.
 */
export async function loadAwsCreds(vault: NimbusVault): Promise<AwsCreds> {
  const ak = await readSecret(vault, "aws", "access_key_id");
  const sk = await readSecret(vault, "aws", "secret_access_key");
  const reg = await readSecret(vault, "aws", "default_region");
  const prof = await readSecret(vault, "aws", "profile");
  const ok = (ak !== "" && sk !== "" && (reg !== "" || prof !== "")) || (prof !== "" && ak === "");
  const env: Record<string, string> = {};
  if (ak !== "") {
    env["AWS_ACCESS_KEY_ID"] = ak;
  }
  if (sk !== "") {
    env["AWS_SECRET_ACCESS_KEY"] = sk;
  }
  if (reg !== "") {
    env["AWS_DEFAULT_REGION"] = reg;
  }
  if (prof !== "") {
    env["AWS_PROFILE"] = prof;
  }
  return { ok, region: reg, env };
}

export async function addUrlAndSecretMcp<S extends ConnectorServiceId>(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
  // Generic over the service id so `urlSecretKey`/`credentialSecretKey` stay
  // checked against THAT service's own key union — `service: string` would
  // typecheck a vault key that does not exist for the connector being wired.
  cfg: {
    service: S;
    urlSecretKey: ConnectorSecretKeyOf<S>;
    credentialSecretKey: ConnectorSecretKeyOf<S>;
    urlEnvVar: string;
    credentialEnvVar: string;
  },
): Promise<void> {
  const url = (await readConnectorSecret(vault, cfg.service, cfg.urlSecretKey))?.trim() ?? "";
  const credential =
    (await readConnectorSecret(vault, cfg.service, cfg.credentialSecretKey))?.trim() ?? "";
  if (url === "" || credential === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts(cfg.service, host === null ? [] : [host]);
  servers[cfg.service] = wrapServerSpec(
    {
      ...connectorSpawn(cfg.service),
      env: extensionProcessEnv({ [cfg.urlEnvVar]: url, [cfg.credentialEnvVar]: credential }),
    },
    manifest,
    sandboxCwd,
  );
}
