/**
 * The `[multimodal]` section (spec § 9.2, § 8).
 *
 * Standalone rather than routed through `nimbus-toml.ts`, mirroring
 * `connectors/openapi-indexer-config.ts`: a small closed set of keys does not warrant a shared
 * parser's full section-table machinery. Reuses `stripComment` from the dependency-free
 * `toml-primitives.ts` so `enabled = true # on locally` reads correctly.
 *
 * DEFAULT OFF, and every MALFORMED-input failure path — absent `configDir`, absent file, absent
 * section, absent key, unreadable or malformed TOML — reads as `false`. A missing config must
 * never read as "on".
 *
 * TWO exceptions to that fail-OFF direction, both well-formed-but-refused values rather than
 * malformed TOML, so neither gets the silent `defaults()` treatment above — each THROWS
 * `MultimodalConfigError` instead:
 *
 *   1. A non-loopback `vlm_base_url`. See `requireLoopbackVlmBaseUrl` for why: this slice has no
 *      per-artifact remote grant, so a remote value can never be honoured, and substituting the
 *      loopback default would silently give the operator local behaviour while ignoring the
 *      setting they actually wrote — the same "parsed then silently ignored" defect this file
 *      already closed for `enabled` and `max_frames`.
 *   2. An unknown/unsupported `remote_vlm` vendor. See `assertRemoteVlmSupported`: silently
 *      disabling the section because of a misspelled vendor name would be indistinguishable, from
 *      the operator's side, from the feature not existing at all.
 *
 * Both checks run AFTER `parseSection` returns, which is why `remote_vlm`'s raw string rides
 * through parsing unvalidated (on the internal `MultimodalConfigDraft.remoteVlmRaw`) rather than
 * being checked inline the way `enabled`/`max_frames` are — `parseSection` itself must stay total
 * and fail-off for actually malformed TOML.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComment } from "../config/toml-primitives.ts";
import { isLoopbackBaseUrl } from "../llm/base-url-locality.ts";
import { isRemoteVlmVendor, REMOTE_VLM_VENDORS, type RemoteVlmVendor } from "./media-types.ts";

/** Loopback, so `isLoopbackBaseUrl` derives `isLocal === true` for the default (I34). */
export const DEFAULT_VLM_BASE_URL = "http://127.0.0.1:11434";

/**
 * A tag the user must have pulled themselves. Nothing here pulls a model: `isAvailable()`
 * reporting false is a refusal condition (spec § 3.4 step 4), not a trigger to download
 * gigabytes during a pass.
 */
export const DEFAULT_VLM_MODEL = "qwen2.5vl:7b";

/** Spec § 8: "a small fixed maximum (default 8) of uniformly spaced keyframes". */
export const DEFAULT_MAX_FRAMES = 8;

/** Spec § 16.9: a generous but finite ceiling on cloud bytes fetched in one run — 2 GiB. */
export const DEFAULT_FETCH_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** Spec § 16.8: fetch the original artifact unless the operator opts into downsized renditions. */
export const DEFAULT_PREFER_RENDITIONS = false;

const MIN_FRAMES = 1;
const MAX_FRAMES_CEILING = 64;

export interface MultimodalConfig {
  readonly enabled: boolean;
  readonly vlmBaseUrl: string;
  readonly vlmModel: string;
  readonly maxFrames: number;
  readonly fetchBudgetBytes: number;
  readonly preferRenditions: boolean;
  /**
   * The frontier vision vendor, or null. Its API key is the EXISTING `[llm.remote.<vendor>]` Vault
   * entry — reusing that credential is deliberate (§ 18.2), because minting a second secret
   * surface for the same vendor and account gives a future bug a second place to leak from.
   * The CAPABILITY is not inherited, which is why this key exists at all: "I gave you my OpenAI
   * key so `nimbus ask` works" is not "you may send my photos to OpenAI".
   */
  readonly remoteVlm: RemoteVlmVendor | null;
}

/**
 * Internal draft carried from `parseSection` to `loadMultimodalConfig`. `remoteVlmRaw` holds the
 * UNVALIDATED `remote_vlm` string (when the key was present at all) so `parseSection` can stay
 * total and fail-off for malformed TOML while the vendor check happens afterward, loudly, next to
 * the existing `vlm_base_url` loopback refusal. Not exported: no caller outside this file needs to
 * see the raw string, and `MultimodalConfig` itself never carries it.
 */
type MultimodalConfigDraft = MultimodalConfig & { remoteVlmRaw?: string };

/**
 * Thrown by `loadMultimodalConfig` — and ONLY by it, never caught internally — when
 * `[multimodal] vlm_base_url` names a non-loopback host. Deliberately a plain propagating `Error`
 * subclass rather than a locally-caught-and-remapped one: `exec/exec-gate.ts`'s `ExecGateError`
 * is the precedent this mirrors — it, too, is thrown from a gate/loader module and left uncaught
 * by its RPC dispatcher, so it surfaces through `ipc/server/server.ts`'s generic top-level catch
 * as JSON-RPC `-32603` with this error's own `message` verbatim. That message is therefore the
 * WHOLE of what the caller sees, so it names both the offending value and the reason.
 */
export class MultimodalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultimodalConfigError";
  }
}

function defaults(): MultimodalConfig {
  return {
    enabled: false,
    vlmBaseUrl: DEFAULT_VLM_BASE_URL,
    vlmModel: DEFAULT_VLM_MODEL,
    maxFrames: DEFAULT_MAX_FRAMES,
    fetchBudgetBytes: DEFAULT_FETCH_BUDGET_BYTES,
    preferRenditions: DEFAULT_PREFER_RENDITIONS,
    remoteVlm: null,
  };
}

export function loadMultimodalConfig(configDir: string | undefined): MultimodalConfig {
  if (configDir === undefined) return defaults();
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return defaults();
  let parsed: MultimodalConfigDraft;
  try {
    parsed = parseSection(readFileSync(tomlPath, "utf8"));
  } catch {
    return defaults();
  }
  // Deliberately OUTSIDE the try/catch above. `parseSection` throwing means the TOML itself could
  // not be trusted — the fail-OFF direction. A non-loopback `vlm_base_url` (and, below, an
  // unsupported `remote_vlm` vendor) is the opposite case: the parser understood it perfectly, so
  // this is a validation refusal, not a parse failure, and must never be caught by the generic
  // `catch { return defaults() }` above it — that would silently substitute the loopback default
  // (or a silently-disabled remote arm) for a value the operator explicitly set, exactly the
  // "parsed then silently ignored" defect this file exists to close.
  const validated = requireLoopbackVlmBaseUrl(parsed);
  return {
    enabled: validated.enabled,
    vlmBaseUrl: validated.vlmBaseUrl,
    vlmModel: validated.vlmModel,
    maxFrames: validated.maxFrames,
    fetchBudgetBytes: validated.fetchBudgetBytes,
    preferRenditions: validated.preferRenditions,
    remoteVlm: assertRemoteVlmSupported(validated),
  };
}

/**
 * Refuses LOUDLY (never `defaults()`) when `vlmBaseUrl` is not a loopback address. This slice's
 * `media-gate.ts` `understandArtifact` refuses `!provider.isLocal` with `no_remote_grant` BEFORE
 * `isAvailable()` or `describe()` ever run — the per-artifact remote grant that would permit a
 * non-loopback VLM lands in a later PR — so a remote `vlm_base_url` can never be honoured today.
 * Worse, it is not just inert: `av-understander.ts` computes `isLocal = stt.isLocal &&
 * vlm.isLocal`, so a remote vision setting silently disables local audio transcription too, a
 * shipped and unrelated feature. Reuses `isLoopbackBaseUrl` (I34) rather than a second predicate.
 */
function requireLoopbackVlmBaseUrl(cfg: MultimodalConfigDraft): MultimodalConfigDraft {
  if (isLoopbackBaseUrl(cfg.vlmBaseUrl)) return cfg;
  throw new MultimodalConfigError(
    `[multimodal] vlm_base_url = "${cfg.vlmBaseUrl}" is not a loopback address. Remote vision ` +
      "understanding requires a per-artifact grant that does not exist in this release: every " +
      'artifact would be refused with "no_remote_grant", and local audio transcription — which ' +
      "needs no VLM at all — would be silently disabled along with it. Point vlm_base_url at a " +
      "loopback host (e.g. http://127.0.0.1:11434) or remove the key.",
  );
}

/**
 * LOUD, not fail-off — the second exception in this file after `requireLoopbackVlmBaseUrl`. A
 * misspelled or unsupported vendor that silently disabled the section would be indistinguishable
 * from the feature not existing at all, so this throws naming the offending value rather than
 * returning `defaults()`. The supported set (`REMOTE_VLM_VENDORS`) is deliberately narrower than
 * the text-model vendor set in `llm/vendor-vault-keys.ts` (which also carries `xai`): a vendor
 * with a text adapter and no vision adapter is refused HERE, at config load, rather than being
 * accepted and failing per-artifact at describe time with no explanation.
 */
function assertRemoteVlmSupported(cfg: MultimodalConfigDraft): RemoteVlmVendor | null {
  if (cfg.remoteVlmRaw === undefined || cfg.remoteVlmRaw === "") return null;
  if (!isRemoteVlmVendor(cfg.remoteVlmRaw)) {
    throw new MultimodalConfigError(
      `[multimodal] remote_vlm = "${cfg.remoteVlmRaw}" is not a vendor with a vision adapter. ` +
        `Supported: ${REMOTE_VLM_VENDORS.join(", ")}. Note this set is deliberately narrower ` +
        "than the text-model vendors in [llm.remote.*] — a vendor can have a text adapter and no " +
        "vision adapter. Fix the value or remove the key to keep image understanding local.",
    );
  }
  return cfg.remoteVlmRaw;
}

/**
 * Unquotes a matching double- or single-quoted TOML string value, or reports MALFORMED (`undefined`)
 * so the caller fails the WHOLE load off — same fail-off direction as the `enabled`/`max_frames`
 * guards below. TOML requires a string value to be quoted; the previous shape returned the raw,
 * un-stripped text for anything that was not a clean `"..."`/`'...'` pair, so an unquoted value
 * (`vlm_model = llava-unquoted`) — malformed TOML — was silently accepted as the literal string
 * `llava-unquoted` instead of failing the section off, in direct contradiction of this file's own
 * header comment that malformed TOML always reads as OFF. A bare word, an unbalanced or mismatched
 * quote (`"foo`, `'foo"`), and an explicitly empty quoted string (`""`, `''` — "with content" is a
 * stated requirement, not a lesser-included case of "use the default") are all malformed here.
 */
function unquote(raw: string): string | undefined {
  const t = raw.trim();
  if (t.length < 2) return undefined;
  const quote = t[0];
  if ((quote !== '"' && quote !== "'") || !t.endsWith(quote)) return undefined;
  const content = t.slice(1, -1);
  return content === "" ? undefined : content;
}

/**
 * Bare integers only — optionally signed, digits-only. Deliberately stricter than
 * `Number.parseInt`, which accepts a numeric PREFIX and silently ignores the rest
 * (`Number.parseInt("8junk", 10) === 8`). A `max_frames` value that isn't a clean integer is
 * malformed TOML, not a value to coerce — see the `undefined` handling at the call site.
 */
const INTEGER_PATTERN = /^[+-]?\d+$/;

function parseStrictInt(raw: string): number | undefined {
  const t = raw.trim();
  if (!INTEGER_PATTERN.test(t)) return undefined;
  return Number.parseInt(t, 10);
}

function clampFrames(n: number): number {
  return Math.min(MAX_FRAMES_CEILING, Math.max(MIN_FRAMES, n));
}

function parseSection(raw: string): MultimodalConfigDraft {
  let inSection = false;
  let out: MultimodalConfigDraft = defaults();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;
    // A malformed header (`[multimodal`) never equals the section name, so it leaves `inSection`
    // false and the whole file reads as defaults — the fail-safe direction.
    if (line.startsWith("[")) {
      inSection = line === "[multimodal]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      // Not blank, not a comment (both already stripped above), not `key = value` — malformed
      // TOML inside the section this file is supposed to be authoritative over. The previous
      // `continue` here read a line like `not valid toml` as "ignore it" and left whatever
      // `enabled = true` above it stood, in direct contradiction of this file's header contract
      // that malformed TOML reads as OFF. Fail the WHOLE load off rather than skip the one line:
      // an operator who cannot trust the file to parse should not get a half-applied result.
      return defaults();
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === "enabled") {
      const v = value.trim().toLowerCase();
      if (v === "true") out = { ...out, enabled: true };
      else if (v === "false") out = { ...out, enabled: false };
      // Neither: a malformed boolean (`enabled = maybe`) is malformed TOML, same fail-off
      // direction as the unstructured-line case above.
      else return defaults();
    } else if (key === "vlm_base_url") {
      const v = unquote(value);
      // An unquoted, unbalanced, or empty value is malformed TOML for this key — same fail-off
      // direction as the unstructured-line and non-boolean-`enabled` cases above.
      if (v === undefined) return defaults();
      out = { ...out, vlmBaseUrl: v };
    } else if (key === "vlm_model") {
      const v = unquote(value);
      if (v === undefined) return defaults();
      out = { ...out, vlmModel: v };
    } else if (key === "remote_vlm") {
      const v = unquote(value);
      // An unquoted, unbalanced, or empty value is malformed TOML for this key — same fail-off
      // direction as the other quoted-string keys above. The VENDOR check (unknown/unsupported)
      // is deliberately NOT here: it happens after parsing, loudly, in `assertRemoteVlmSupported`
      // — see that function and this file's header comment for why.
      if (v === undefined) return defaults();
      out = { ...out, remoteVlmRaw: v };
    } else if (key === "max_frames") {
      const n = parseStrictInt(value);
      // A non-integer value (`8junk`, `nonsense`) is malformed TOML for this key — same fail-off
      // direction, not a silent fallback to the default frame count.
      if (n === undefined) return defaults();
      out = { ...out, maxFrames: clampFrames(n) };
    } else if (key === "fetch_budget_bytes") {
      const n = parseStrictInt(value);
      // A non-integer value is malformed TOML for this key — same fail-off direction as
      // `max_frames` and `enabled`. A negative value is semantically malformed: this file's
      // contract is that a value it cannot honour turns the section off rather than silently
      // substituting one the user did not ask for. Zero is accepted and means "no cloud bytes
      // may be fetched this run".
      if (n === undefined || n < 0) return defaults();
      out = { ...out, fetchBudgetBytes: n };
    } else if (key === "prefer_renditions") {
      const v = value.trim().toLowerCase();
      if (v === "true") out = { ...out, preferRenditions: true };
      else if (v === "false") out = { ...out, preferRenditions: false };
      // Neither: a malformed boolean is malformed TOML, same fail-off direction as
      // non-boolean `enabled`.
      else return defaults();
    }
    // An unrecognised but well-formed key (e.g. a future `vlm_prompt` this binary predates) is
    // deliberately IGNORED rather than failing the section off. Chosen over the stricter
    // alternative for forward-compatibility: a newer `nimbus.toml` written by (or shared with) a
    // newer gateway must not silently disable this default-off, privacy-sensitive capability on
    // an older binary just because it doesn't recognise one extra key. Contrast with the two
    // guards above, which reject a value this parser cannot trust at all (a non-boolean
    // `enabled`, a non-integer `max_frames`) — an unknown key carries no such ambiguity.
  }
  return out;
}
