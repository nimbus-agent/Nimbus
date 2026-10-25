// Installing, previewing, removing and listing role packs: the gate module for `pack.install`.
// A pack layer is written here only after the LOCAL owner approved `pack.install` over a prompt
// that showed the exact `defaults` bytes about to be written; every refusal happens before the
// prompt, in a fixed order, and a denied approval writes nothing. This is the only caller of the
// store's write half (`setPackLayer`/`removePackLayer`) outside the store itself.

import {
  parseRolePackManifest,
  RegistryError,
  type RolePackManifest,
  rolePackDigest,
} from "@nimbus-dev/registry-format";
import { normaliseAgentName } from "../catalog/agent-visibility.ts";
import { type ExplainEntry, explainConfig } from "../config/config-explain.ts";
import { parseNimbusTomlFleetJobs } from "../config/fleet-toml.ts";
import { getLayeredConfig, type SkippedPack } from "../config/layered-config.ts";
import type { LayerRef } from "../config/layered-merge.ts";
import { checkPackFragment, PACK_ID_RE } from "../config/pack-settable.ts";
import { parseString } from "../config/toml-primitives.ts";
import { type SourceMapEntry, sourceMapFromList } from "../sources/source-mapping.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";
import { PackLayerRefusedError, type PackLayerStore } from "./pack-layer-store.ts";
import {
  diffPacks,
  type PackPromptInput,
  type PromptScalar,
  renderPackPrompt,
  visibleText,
} from "./pack-prompt.ts";
import {
  type InstalledPackRecord,
  type PackSource,
  parsePackRecord,
  serializePackRecord,
} from "./pack-record.ts";
import { validatePackContent } from "./pack-validate.ts";

export type PackErrorCode =
  | "ERR_PACK_NOT_FOUND"
  | "ERR_PACK_ID_RESERVED"
  | "ERR_PACK_LOCAL_FILE_PRODUCTION"
  | "ERR_PACK_MEMBERS_UNSUPPORTED"
  | "ERR_PACK_CONFLICT"
  | "ERR_PACK_INVALID"
  | "ERR_PACK_STORE_UNREADABLE"
  | "ERR_PACK_INSTALL_NOT_APPROVED";

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PackError";
  }
}

export type PackRequest =
  | { readonly id: string }
  | { readonly fileText: string; readonly filePath: string };

/** The local owner's HITL gate (`ToolExecutor.gate`): `true` only for "proceed". */
export type PackOwnerGate = (action: {
  type: "pack.install";
  payload: Record<string, unknown>;
}) => Promise<boolean>;

export type PackDeps = {
  readonly store: PackLayerStore;
  /** For the layered reader (`config explain`'s data) and the running profile. */
  readonly configDir: string;
  readonly bundled: ReadonlyMap<string, RolePackManifest>;
  readonly isProduction: () => boolean;
  readonly isConfigured: (serviceId: string) => Promise<boolean>;
  readonly connectorIds: ReadonlySet<string>;
  readonly agentNames: ReadonlySet<string>;
  readonly now: () => Date;
};

export type InstallOutcome = "installed" | "updated" | "repaired" | "already_installed";

export type PackListResult = {
  readonly profile: string;
  readonly installed: readonly {
    id: string;
    name: string;
    version: string;
    source: "bundled" | "file";
    updateAvailable: boolean;
    bundledVersion?: string;
    versionUnknown?: true;
    /** Agents the installed record's defaults make visible, normalised; `[]` when unreadable. */
    visibleAgents: readonly string[];
    /** The `[sources] map` entries the installed record's defaults add; `[]` when unreadable. */
    sourceMappings: readonly SourceMapEntry[];
  }[];
  readonly available: readonly { id: string; name: string; version: string; description: string }[];
  readonly skipped: readonly SkippedPack[];
  readonly listError?: string;
};

type Resolved = {
  readonly manifest: RolePackManifest;
  readonly source: PackSource;
  readonly digest: string;
};

type Mode =
  | { readonly kind: "install" }
  | { readonly kind: "repair" }
  | { readonly kind: "already_installed" }
  | { readonly kind: "update"; readonly prev: RolePackManifest };

/** The profile every pack method acts on: the one the running layered reader pinned at boot. */
function activeProfile(configDir: string): string {
  return getLayeredConfig(configDir).profile.name;
}

/** The active profile's parsed record for `id`; undefined when absent or it does not verify. */
function readRecord(
  profile: string,
  id: string,
  store: PackLayerStore,
): InstalledPackRecord | undefined {
  const text = store.readPackRecord(profile, id);
  return text === undefined ? undefined : parsePackRecord(text);
}

/**
 * An id names a bundled pack. For `pack.show` only (`installedProfile` set), a non-bundled id
 * also names the pack installed under it in that profile, read from its record. `pack.install`
 * stays bundled-only: a local-file pack is re-installed from its file.
 */
function resolveId(id: string, deps: PackDeps, installedProfile: string | undefined) {
  const bundled = deps.bundled.get(id);
  if (bundled !== undefined) return { manifest: bundled, source: { kind: "bundled" } as const };
  if (installedProfile === undefined) {
    throw new PackError(
      "ERR_PACK_NOT_FOUND",
      `no bundled pack "${id}"; a local-file pack is installed with --file`,
    );
  }
  const record = readRecord(installedProfile, id, deps.store);
  if (record === undefined) {
    throw new PackError("ERR_PACK_NOT_FOUND", `no bundled or installed pack "${id}"`);
  }
  return { manifest: record.manifest, source: record.source };
}

/** Steps 1–5 of the fixed order: which manifest, from where, and whether it may be considered. */
function resolveRequest(req: PackRequest, deps: PackDeps, installedProfile?: string): Resolved {
  let manifest: RolePackManifest;
  let source: PackSource;
  if ("id" in req) {
    ({ manifest, source } = resolveId(req.id, deps, installedProfile));
  } else {
    if (deps.isProduction()) {
      throw new PackError(
        "ERR_PACK_LOCAL_FILE_PRODUCTION",
        "a local-file pack is refused in a production runtime",
      );
    }
    // The parse precedes the id check: a file pack's id is unknown until its text is parsed.
    try {
      manifest = parseRolePackManifest(req.fileText);
    } catch (err) {
      if (err instanceof RegistryError) throw new PackError("ERR_PACK_INVALID", err.detail);
      throw err;
    }
    if (deps.bundled.has(manifest.id)) {
      throw new PackError(
        "ERR_PACK_ID_RESERVED",
        `"${manifest.id}" is a bundled pack id; a local file cannot use it`,
      );
    }
    source = { kind: "file", path: req.filePath };
  }
  if (manifest.members.length > 0) {
    throw new PackError(
      "ERR_PACK_MEMBERS_UNSUPPORTED",
      "a pack with members cannot be installed yet",
    );
  }
  return { manifest, source, digest: rolePackDigest(manifest) };
}

/** Steps 6–8: content against this gateway, then the store's own non-writing check. */
function assertInstallable(manifest: RolePackManifest, profile: string, deps: PackDeps): void {
  const problems = validatePackContent(manifest, deps);
  if (problems.length > 0) throw new PackError("ERR_PACK_INVALID", problems.join("; "));
  const check = deps.store.checkPackLayer(profile, manifest.id, manifest.defaults);
  if (!check.ok) throw refusalError(check.reason, check.problems);
}

function refusalError(
  reason: PackLayerRefusedError["reason"],
  problems: readonly string[],
): PackError {
  const detail = problems.join("; ");
  if (reason === "store") return new PackError("ERR_PACK_STORE_UNREADABLE", detail);
  if (reason === "conflict") return new PackError("ERR_PACK_CONFLICT", detail);
  return new PackError("ERR_PACK_INVALID", detail);
}

function isListed(profile: string, id: string, store: PackLayerStore): boolean {
  const r = store.read(profile);
  return r.layers.some((l) => l.id === id) || r.skipped.some((s) => s.packId === id);
}

function selectMode(r: Resolved, profile: string, store: PackLayerStore): Mode {
  const id = r.manifest.id;
  const record = readRecord(profile, id, store);
  // A listed pack whose record is missing or does not verify has no prior manifest to diff
  // against, so it prompts in install mode with the full text (spec § 5.4: "version unknown").
  if (record === undefined) return { kind: "install" };
  if (record.digest !== r.digest) return { kind: "update", prev: record.manifest };
  // Equal digest: a no-op only if the approved bytes are still on disk AND still listed. A
  // deleted or hand-edited layer, or one a crash left unlisted, is a repair, never a no-op.
  const intact =
    store.readPackLayerText(profile, id) === r.manifest.defaults && isListed(profile, id, store);
  return intact ? { kind: "already_installed" } : { kind: "repair" };
}

function layerLabel(entry: ExplainEntry): string {
  if (entry.source.kind === "env") return `env ${entry.source.envVar}`;
  return refLabel(entry.source.layer);
}

function refLabel(l: LayerRef): string {
  if (l.kind === "pack") return `pack ${l.id}`;
  if (l.kind === "base") return "nimbus.toml";
  if (l.kind === "profile") return `profile ${l.id}`;
  return "team";
}

const isUserLayer = (l: LayerRef): boolean => l.kind === "base" || l.kind === "profile";

function promptScalars(defaults: string, configDir: string): PromptScalar[] {
  const parsed = checkPackFragment(defaults, checkPackFleetJobs);
  if (!parsed.ok) return [];
  const reader = getLayeredConfig(configDir);
  const rows: PromptScalar[] = [];
  for (const [key, value] of parsed.scalars) {
    const winner = explainConfig(reader, key).entries[0];
    rows.push({
      key,
      packValue: String(value),
      current: winner?.value,
      currentLayer: winner === undefined ? "default" : layerLabel(winner),
      // A pack layer (this pack's own previous one included) never counts as an override.
      userOverrides: winner?.source.kind === "layer" && isUserLayer(winner.source.layer),
    });
  }
  return rows;
}

/** The owner's own `[[fleet.job]]` names (base or profile layer), which shadow a pack job's name. */
function userJobNames(configDir: string): ReadonlySet<string> {
  const names = new Set<string>();
  const blocks = explainConfig(getLayeredConfig(configDir), "fleet.job").blocks ?? [];
  for (const b of blocks) {
    if (!isUserLayer(b.layer)) continue;
    const entry = b.entries.find((e) => e.path === `${b.header}.name`);
    if (entry !== undefined) names.add(parseString(entry.value));
  }
  return names;
}

async function buildPrompt(
  r: Resolved,
  mode: PackPromptInput["mode"],
  prev: RolePackManifest | undefined,
  deps: PackDeps,
  layerEdited = false,
): Promise<string> {
  const m = r.manifest;
  const parsed = checkPackFragment(m.defaults, checkPackFleetJobs);
  const visibleAgents = parsed.ok ? (parsed.lists.get("agents.visible") ?? []) : [];
  const sourceMappings = parsed.ok ? (parsed.lists.get("sources.map") ?? []) : [];
  const replaced = userJobNames(deps.configDir);
  const jobs = parseNimbusTomlFleetJobs(m.defaults).map((j) => ({
    name: j.name,
    agent: j.agent,
    intervalSeconds: j.intervalSeconds,
    userReplaces: replaced.has(j.name),
  }));
  const connectors = await Promise.all(
    m.suggestedConnectors.map(async (id) => ({ id, configured: await deps.isConfigured(id) })),
  );
  const input: PackPromptInput = {
    manifest: m,
    source: r.source,
    mode,
    ...(prev === undefined ? {} : { diff: diffPacks(prev, m) }),
    ...(layerEdited ? { layerEdited } : {}),
    scalars: promptScalars(m.defaults, deps.configDir),
    visibleAgents,
    sourceMappings,
    jobs,
    connectors,
  };
  return renderPackPrompt(input);
}

/** True when the layer file on disk is no longer the `defaults` the previous record approved. */
function isLayerEdited(mode: Mode, profile: string, id: string, store: PackLayerStore): boolean {
  return mode.kind === "update" && store.readPackLayerText(profile, id) !== mode.prev.defaults;
}

/**
 * A path is one line, so LF and TAB are escaped too (`visibleText` keeps them for multi-line
 * prompt text). This string reaches the audit row and `pack show`, outside the escaped prompt.
 */
function sourceDisplay(s: PackSource): string {
  if (s.kind === "bundled") return "bundled";
  const path = visibleText(s.path)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`);
  return `local file ${path}`;
}

/** Resolves, checks and picks the mode: everything install does before the gate. */
function prepare(
  req: PackRequest,
  deps: PackDeps,
  opts: { readonly showInstalled?: boolean } = {},
): { r: Resolved; profile: string; mode: Mode } {
  const profile = activeProfile(deps.configDir);
  const r = resolveRequest(req, deps, opts.showInstalled === true ? profile : undefined);
  assertInstallable(r.manifest, profile, deps);
  return { r, profile, mode: selectMode(r, profile, deps.store) };
}

const OUTCOME: Readonly<Record<"install" | "update" | "repair", InstallOutcome>> = {
  install: "installed",
  update: "updated",
  repair: "repaired",
};

export async function installPack(
  req: PackRequest,
  deps: PackDeps,
  gate: PackOwnerGate,
): Promise<{
  outcome: InstallOutcome;
  id: string;
  version: string;
  snapshotVersion: number | null;
}> {
  const { r, profile, mode } = prepare(req, deps);
  const { id, version } = r.manifest;
  if (mode.kind === "already_installed") {
    return { outcome: "already_installed", id, version, snapshotVersion: null };
  }
  const promptText = await buildPrompt(
    r,
    mode.kind,
    mode.kind === "update" ? mode.prev : undefined,
    deps,
    isLayerEdited(mode, profile, id, deps.store),
  );
  const approved = await gate({
    type: "pack.install",
    payload: { packId: id, version, source: sourceDisplay(r.source), digest: r.digest, promptText },
  });
  if (!approved) {
    throw new PackError("ERR_PACK_INSTALL_NOT_APPROVED", `the owner did not approve pack "${id}"`);
  }
  const record = serializePackRecord({
    manifest: r.manifest,
    digest: r.digest,
    source: r.source,
    installedAt: deps.now().toISOString(),
  });
  try {
    // `setPackLayer` re-runs the same checks, closing the window between the prompt and the write.
    const written = deps.store.setPackLayer(profile, id, r.manifest.defaults, { record });
    return { outcome: OUTCOME[mode.kind], id, version, snapshotVersion: written.snapshotVersion };
  } catch (err) {
    if (err instanceof PackLayerRefusedError) throw refusalError(err.reason, err.problems);
    throw err;
  }
}

export type PackPreview = {
  readonly prompt: string;
  readonly mode: "install" | "update" | "repair" | "already_installed";
  /** Present when the pack is listed in the active profile and its record parses. */
  readonly installed?: {
    readonly version: string;
    /** `bundled` or `local file <path>`. */
    readonly source: string;
    readonly installedAt: string;
    readonly digest: string;
  };
};

/**
 * What `installPack` would prompt, without raising the gate. Same refusals, same order, except that
 * an id may also name a non-bundled pack installed in the active profile (rendered from its record).
 */
export async function previewPack(req: PackRequest, deps: PackDeps): Promise<PackPreview> {
  const { r, profile, mode } = prepare(req, deps, { showInstalled: true });
  const record = isListed(profile, r.manifest.id, deps.store)
    ? readRecord(profile, r.manifest.id, deps.store)
    : undefined;
  const installed =
    record === undefined
      ? {}
      : {
          installed: {
            version: record.manifest.version,
            source: sourceDisplay(record.source),
            installedAt: record.installedAt,
            digest: record.digest,
          },
        };
  if (mode.kind === "already_installed") {
    // Nothing would be prompted: the summary of what is installed, headed as installed.
    const prompt = await buildPrompt(r, "installed", undefined, deps);
    return { prompt, mode: "already_installed", ...installed };
  }
  const prev = mode.kind === "update" ? mode.prev : undefined;
  const edited = isLayerEdited(mode, profile, r.manifest.id, deps.store);
  const prompt = await buildPrompt(r, mode.kind, prev, deps, edited);
  return { prompt, mode: mode.kind, ...installed };
}

/** No approval: removing a pack only takes its defaults away. An unknown id is `removed: false`. */
export function removePack(
  id: string,
  deps: PackDeps,
): { removed: boolean; snapshotVersion: number | null } {
  try {
    const r = deps.store.removePackLayer(activeProfile(deps.configDir), id);
    return { removed: r.removed, snapshotVersion: r.snapshotVersion };
  } catch (err) {
    if (err instanceof PackLayerRefusedError) throw refusalError(err.reason, err.problems);
    throw err;
  }
}

export function listPacks(deps: PackDeps): PackListResult {
  const profile = activeProfile(deps.configDir);
  const read = deps.store.read(profile);
  const ids: string[] = [];
  // A skipped pack is still listed in `active.json` (the one "is it active" authority); only an
  // entry whose id was itself invalid (`#<n>`) has no id to show.
  for (const id of [...read.layers.map((l) => l.id), ...read.skipped.map((s) => s.packId)]) {
    if (PACK_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  const installed = ids.map((id) => installedEntry(profile, id, deps));
  // With the installed list unreadable, nothing is known about what is installed, so nothing is
  // offered as available.
  const available = (read.listError === undefined ? [...deps.bundled.values()] : [])
    .filter((m) => !ids.includes(m.id))
    .map((m) => ({ id: m.id, name: m.name, version: m.version, description: m.description }));
  return {
    profile,
    installed,
    available,
    skipped: read.skipped,
    ...(read.listError === undefined ? {} : { listError: read.listError }),
  };
}

function installedEntry(
  profile: string,
  id: string,
  deps: PackDeps,
): PackListResult["installed"][number] {
  const bundled = deps.bundled.get(id);
  const record = readRecord(profile, id, deps.store);
  if (record === undefined) {
    // Version unknown: for a bundled id that is "update available" (spec § 5.4).
    return {
      id,
      name: bundled?.name ?? id,
      version: "unknown",
      source: bundled === undefined ? "file" : "bundled",
      updateAvailable: bundled !== undefined,
      ...(bundled === undefined ? {} : { bundledVersion: bundled.version }),
      versionUnknown: true,
      visibleAgents: [],
      sourceMappings: [],
    };
  }
  const m = record.manifest;
  const newer =
    record.source.kind === "bundled" &&
    bundled !== undefined &&
    rolePackDigest(bundled) !== record.digest;
  return {
    id,
    name: m.name,
    version: m.version,
    source: record.source.kind,
    updateAvailable: newer,
    ...(newer ? { bundledVersion: bundled.version } : {}),
    visibleAgents: packVisibleAgents(m.defaults),
    sourceMappings: packSourceMappings(m.defaults),
  };
}

/** The agents a pack's defaults make visible: normalised, first occurrence wins, `[]` if invalid. */
export function packVisibleAgents(defaults: string): readonly string[] {
  const parsed = checkPackFragment(defaults, checkPackFleetJobs);
  if (!parsed.ok) return [];
  const out: string[] = [];
  for (const name of parsed.lists.get("agents.visible") ?? []) {
    const n = normaliseAgentName(name);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The source types a pack's defaults add, in written order; `[]` if the defaults are invalid. */
export function packSourceMappings(defaults: string): readonly SourceMapEntry[] {
  const parsed = checkPackFragment(defaults, checkPackFleetJobs);
  if (!parsed.ok) return [];
  return [...sourceMapFromList(parsed.lists.get("sources.map"))].map(([serviceType, kind]) => ({
    serviceType,
    kind,
  }));
}
