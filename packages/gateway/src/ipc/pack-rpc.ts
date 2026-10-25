// `pack.*` (LAN-forbidden): list, show, install and remove role packs in the running profile.
// `pack.list` and `pack.install` are on the Tauri allowlist; a renderer connection may install a
// BUNDLED pack by id only — the local-file form is refused for it before anything is read (I47). Thin: it validates params and hands off to
// `packs/pack-install.ts`, which owns every refusal, the prompt and the one write path. Only
// `pack.install` asks the owner, through the gate the outer dispatcher builds.

import { isAbsolute } from "node:path";
import { CATALOG_AGENT_NAMES } from "../catalog/agent-catalog.ts";
import { builtinCatalogConnectorIds } from "../catalog/catalog-list.ts";
import { BUNDLED_PACKS } from "../packs/bundled-packs.ts";
import {
  installPack,
  listPacks,
  type PackDeps,
  PackError,
  type PackOwnerGate,
  type PackRequest,
  previewPack,
  removePack,
} from "../packs/pack-install.ts";
import type { PackLayerStore } from "../packs/pack-layer-store.ts";
import { isProductionRuntime } from "../platform/runtime-layout.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/** Production `PackDeps`: the live catalog's connector ids and agent names, the bundled packs. */
export function buildPackDeps(opts: {
  readonly store: PackLayerStore;
  readonly configDir: string;
  readonly isConfigured: (serviceId: string) => Promise<boolean>;
}): PackDeps {
  return {
    store: opts.store,
    configDir: opts.configDir,
    bundled: BUNDLED_PACKS,
    isProduction: () => isProductionRuntime(),
    isConfigured: opts.isConfigured,
    connectorIds: new Set(builtinCatalogConnectorIds()),
    agentNames: new Set(CATALOG_AGENT_NAMES),
    now: () => new Date(),
  };
}

function invalid(message: string): RpcMethodError {
  return new RpcMethodError(-32602, `ERR_INVALID_PARAMS: ${message}`);
}

function asObject(params: unknown, method: string): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw invalid(`${method} takes an object`);
  }
  return params as Record<string, unknown>;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

function parseId(params: unknown, method: string): string {
  const o = asObject(params, method);
  const id = o["id"];
  if (!isNonEmptyString(id)) throw invalid(`${method} needs a non-empty string id`);
  return id;
}

/** `{ id }` or `{ fileText, filePath }` (an absolute path), never both. */
function parseRequest(params: unknown, method: string): PackRequest {
  const o = asObject(params, method);
  const hasFile = o["fileText"] !== undefined || o["filePath"] !== undefined;
  if (o["id"] !== undefined) {
    if (hasFile) throw invalid(`${method} takes id or fileText/filePath, not both`);
    return { id: parseId(o, method) };
  }
  const fileText = o["fileText"];
  const filePath = o["filePath"];
  if (!isNonEmptyString(fileText) || !isNonEmptyString(filePath)) {
    throw invalid(`${method} needs id, or non-empty fileText and filePath`);
  }
  if (!isAbsolute(filePath)) throw invalid(`${method} filePath must be absolute`);
  return { fileText, filePath };
}

function assertNoParams(params: unknown, method: string): void {
  if (params === undefined || params === null) return;
  const o = asObject(params, method);
  if (Object.keys(o).length > 0) throw invalid(`${method} takes no params`);
}

/**
 * I47: the desktop installs bundled packs by id only. A renderer connection (the Tauri bridge
 * declares `ui` before any renderer frame, and the renderer cannot reach `session.declareKind`)
 * sending the file form is refused before `parseRequest` touches the text and before any gate.
 */
function refuseRendererFile(method: string, params: unknown, fromRenderer: boolean): void {
  if (!fromRenderer || (method !== "pack.install" && method !== "pack.show")) return;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return;
  const o = params as Record<string, unknown>;
  if (o["fileText"] !== undefined || o["filePath"] !== undefined) {
    throw new RpcMethodError(
      -32000,
      "ERR_PACK_RENDERER_FILE: the desktop installs bundled packs by id only",
    );
  }
}

async function run(
  method: string,
  params: unknown,
  deps: PackDeps,
  gate: PackOwnerGate | undefined,
): Promise<unknown> {
  switch (method) {
    case "pack.list":
      assertNoParams(params, method);
      return listPacks(deps);
    case "pack.show":
      return previewPack(parseRequest(params, method), deps);
    case "pack.install": {
      const req = parseRequest(params, method);
      if (gate === undefined) {
        throw new RpcMethodError(-32603, "pack.install needs the owner's approval gate");
      }
      return installPack(req, deps, gate);
    }
    case "pack.remove":
      return removePack(parseId(params, method), deps);
    default:
      return undefined;
  }
}

const METHODS: ReadonlySet<string> = new Set([
  "pack.list",
  "pack.show",
  "pack.install",
  "pack.remove",
]);

export async function dispatchPackRpc(
  method: string,
  params: unknown,
  deps: PackDeps,
  gate: PackOwnerGate | undefined,
  /** The connection's declared kind is `ui` (filled by the dispatcher, never a request field). */
  fromRenderer: boolean,
): Promise<{ kind: "hit"; value: unknown } | { kind: "skip" }> {
  if (!METHODS.has(method)) return { kind: "skip" };
  refuseRendererFile(method, params, fromRenderer);
  try {
    return { kind: "hit", value: await run(method, params, deps, gate) };
  } catch (err) {
    if (err instanceof PackError) throw new RpcMethodError(-32000, err.message);
    throw err;
  }
}
