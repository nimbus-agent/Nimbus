import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { SyncContext } from "../../sync/types.ts";
import { readConnectorSecret } from "../connector-vault.ts";

/**
 * Resolve the AWS credential environment from the shared `aws.*` vault keys
 * (`access_key_id`, `secret_access_key`, `default_region`, `profile`). Returns
 * the scoped env map to inject at spawn time, or `null` when no usable
 * credential combination is present (the caller degrades to a no-op).
 *
 * Usable combinations:
 *  - access key + secret + (region OR profile), or
 *  - profile alone (no access key).
 *
 * Shared by every AWS-CLI-backed connector (aws, athena, …). Adding a connector
 * that reuses AWS creds means importing this helper rather than re-reading keys.
 */
export async function awsCredentialsExtra(
  ctx: SyncContext,
): Promise<Record<string, string> | null> {
  const ak = (await readConnectorSecret(ctx.vault, "aws", "access_key_id"))?.trim() ?? "";
  const sk = (await readConnectorSecret(ctx.vault, "aws", "secret_access_key"))?.trim() ?? "";
  const reg = (await readConnectorSecret(ctx.vault, "aws", "default_region"))?.trim() ?? "";
  const prof = (await readConnectorSecret(ctx.vault, "aws", "profile"))?.trim() ?? "";
  const ok = (ak !== "" && sk !== "" && (reg !== "" || prof !== "")) || (prof !== "" && ak === "");
  if (!ok) {
    return null;
  }
  const extra: Record<string, string> = {};
  if (ak !== "") {
    extra["AWS_ACCESS_KEY_ID"] = ak;
  }
  if (sk !== "") {
    extra["AWS_SECRET_ACCESS_KEY"] = sk;
  }
  if (reg !== "") {
    extra["AWS_DEFAULT_REGION"] = reg;
  }
  if (prof !== "") {
    extra["AWS_PROFILE"] = prof;
  }
  return extra;
}

/**
 * Spawn `aws <args> --output json` with the resolved AWS credential env scoped
 * via `extensionProcessEnv` (invariant I1). Returns `{ ok, text }` — `ok` is the
 * exit-zero flag, `text` the captured stdout. Returns `{ ok: false, text: "" }`
 * when no usable credentials are present (no spawn). Never throws past this
 * boundary — callers degrade gracefully on `!ok`.
 */
export async function awsCliJson(
  ctx: SyncContext,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  const extra = await awsCredentialsExtra(ctx);
  if (extra === null) {
    return { ok: false, text: "" };
  }
  const proc = Bun.spawn(["aws", ...args, "--output", "json"], {
    env: extensionProcessEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  return { ok: code === 0, text: out };
}
