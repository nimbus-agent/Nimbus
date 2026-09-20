import { ConnectorRpcError } from "../../ipc/connector-rpc-shared.ts";
import type { ConnectorServiceId } from "../connector-catalog.ts";
import { detectAws } from "./detect-aws.ts";
import { detectGcloud } from "./detect-gcloud.ts";
import { detectGh } from "./detect-gh.ts";
import { detectKubectl } from "./detect-kubectl.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import {
  LOCAL_AUTH_SERVICE,
  LOCAL_AUTH_SOURCES,
  type LocalAuthFinding,
  type LocalAuthSource,
} from "./local-auth-types.ts";

export interface DetectLocalAuthDeps {
  readonly host: LocalAuthHostDeps;
  readonly isConfigured: (service: ConnectorServiceId) => Promise<boolean>;
}

function isSource(v: unknown): v is LocalAuthSource {
  return typeof v === "string" && (LOCAL_AUTH_SOURCES as readonly string[]).includes(v);
}

/** `undefined` → all sources; otherwise a de-duplicated subset in canonical order. */
export function parseSources(raw: unknown): readonly LocalAuthSource[] {
  if (raw === undefined) return LOCAL_AUTH_SOURCES;
  if (!Array.isArray(raw) || !raw.every(isSource)) {
    throw new ConnectorRpcError(
      -32602,
      `sources must be an array of: ${LOCAL_AUTH_SOURCES.join(", ")}`,
    );
  }
  return LOCAL_AUTH_SOURCES.filter((s) => raw.includes(s));
}

async function detectOne(
  source: LocalAuthSource,
  deps: DetectLocalAuthDeps,
): Promise<LocalAuthFinding[]> {
  const configured = await deps.isConfigured(LOCAL_AUTH_SERVICE[source]);
  switch (source) {
    case "gh":
      return detectGh(deps.host, configured);
    case "aws":
      return [await detectAws(deps.host, configured)];
    case "kubectl":
      return [await detectKubectl(deps.host, configured)];
    case "gcloud":
      return [await detectGcloud(deps.host, configured)];
  }
}

/** Detectors run in parallel; each is local-only and bounded by `LOCAL_AUTH_CLI_TIMEOUT_MS`. */
export async function detectLocalAuth(
  sources: readonly LocalAuthSource[],
  deps: DetectLocalAuthDeps,
): Promise<LocalAuthFinding[]> {
  return (await Promise.all(sources.map((s) => detectOne(s, deps)))).flat();
}
