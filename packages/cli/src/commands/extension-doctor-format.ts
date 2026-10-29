import { stripControl } from "./captures-format.ts";
import { parseRequirementStatuses } from "./extension-requirements-format.ts";

/** How many extension ids the doctor line names before summarising the rest. */
const MAX_LISTED = 5;

const NEEDS_APPROVAL = new Set(["no_grant", "grant_stale"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function grantHadModelAccess(grant: unknown): boolean {
  return isRecord(grant) && grant["modelAccess"] === true;
}

/**
 * One `[warn]` per extension the gateway reports `blocked` (I48): a revocation or takedown its run
 * approval did not acknowledge. Named even with the runtime off, since it is a fact about the code.
 */
function blockedLines(extensions: readonly unknown[]): string[] {
  return extensions.flatMap((e: unknown) => {
    if (!isRecord(e) || typeof e["id"] !== "string" || e["runState"] !== "blocked") return [];
    const id = stripControl(e["id"]);
    const first = Array.isArray(e["blockedBy"]) ? e["blockedBy"].find(isRecord) : undefined;
    const kind =
      first?.["kind"] === "key.revoke" ? "its publisher key was revoked" : "it was taken down";
    const reason =
      typeof first?.["reason"] === "string" ? ` (${stripControl(first["reason"])})` : "";
    return [
      `[warn] Extensions: ${id} is blocked: ${kind}${reason} — it does not run; nimbus extension info ${id}`,
    ];
  });
}

/**
 * One `[warn]` per requirement an installed extension has that is not connected, or never synced.
 * Only `not_connected` is unmet (spec § 5.4): `unmet` says whether any line raises the exit code.
 */
function requirementWarnLines(extensions: readonly unknown[]): { lines: string[]; unmet: boolean } {
  let unmet = false;
  const lines = extensions.flatMap((e: unknown) => {
    if (!isRecord(e) || typeof e["id"] !== "string") return [];
    const id = stripControl(e["id"]);
    return parseRequirementStatuses(e["requires"])
      .filter((r) => r.state === "not_connected" || r.state === "configured_never_synced")
      .map((r) => {
        if (r.state === "not_connected") unmet = true;
        return `[warn] Extensions: ${id} needs ${stripControl(r.connector)} — run: ${r.fix.map(stripControl).join(" && ")}`;
      });
  });
  return { lines, unmet };
}

/**
 * `nimbus doctor`'s extensions line, from an `extension.list` response: one `[warn]` naming the
 * installed extensions that have no run approval or an approval for older code, so an upgrade that
 * left them unapproved is visible rather than silent. Silent when there are none, and when the
 * gateway reports the extension runtime off — approving one would be refused then. Blocked
 * extensions and connector-requirement warnings are reported whether or not the runtime is on; of
 * the requirement warnings only `not_connected` raises the exit code. An older gateway
 * that does not report `runtimeEnabled` is treated as having it on. Throws on a malformed response;
 * the caller turns that into a `[warn]`.
 */
export function doctorExtensionsLines(raw: unknown): { lines: string[]; exit: number } {
  if (!isRecord(raw) || !Array.isArray(raw["extensions"])) {
    throw new Error("malformed extension.list response from the gateway");
  }
  const blockedOnly = blockedLines(raw["extensions"]);
  const needs = requirementWarnLines(raw["extensions"]);
  const blocked = [...blockedOnly, ...needs.lines];
  // A never-synced requirement warns but is not unmet; a blocked extension or an unconnected one is.
  const baseExit = blockedOnly.length > 0 || needs.unmet ? 1 : 0;
  if (raw["runtimeEnabled"] === false) {
    return { lines: blocked, exit: baseExit };
  }
  const flagged = raw["extensions"].flatMap((e: unknown) =>
    isRecord(e) &&
    typeof e["id"] === "string" &&
    typeof e["runState"] === "string" &&
    NEEDS_APPROVAL.has(e["runState"]) &&
    // A starter pack has no code and is never approved to run (its state is `pack`); an approval
    // warning for one would send the owner to a command the gateway refuses.
    e["kind"] !== "starter-pack"
      ? [{ id: stripControl(e["id"]), hadModelAccess: grantHadModelAccess(e["runGrant"]) }]
      : [],
  );
  if (flagged.length === 0) return { lines: blocked, exit: baseExit };
  const ids = flagged.map((f) => f.id);
  // Every approval states the whole grant, so a bare `approve <id>` after an update would turn
  // model access off; name the extensions that need `--model` again.
  const keepModel = flagged.filter((f) => f.hadModelAccess).map((f) => f.id);
  const modelHint =
    keepModel.length === 0 ? "" : `; add --model to keep model access for: ${keepModel.join(", ")}`;
  const shown = ids.slice(0, MAX_LISTED).join(", ");
  const more = ids.length > MAX_LISTED ? `, +${ids.length - MAX_LISTED} more` : "";
  return {
    lines: [
      ...blocked,
      `[warn] Extensions: ${ids.length} installed extension(s) not approved to run, or approved for an older version (${shown}${more}) — nimbus extension approve <id>${modelHint}`,
    ],
    exit: 1,
  };
}

/**
 * `nimbus doctor`'s extension-registry lines, from a `registry.list` and an `extension.list`
 * response: one `[warn]` naming installed extensions whose `source_registry` is no longer a
 * configured registry (they keep running but get no further updates, spec § 8.3), and one per
 * registry whose signed index is older than 30 days (the gateway's `stale` flag): a registry that
 * stops publishing can hold back updates indefinitely, since an index never expires. Silent when
 * no registry is configured and no installed extension came from one. Throws on a malformed
 * response; the caller turns that into a `[warn]`.
 */
export function doctorRegistryLines(
  registriesRaw: unknown,
  extensionsRaw: unknown,
): { lines: string[]; exit: number } {
  if (!isRecord(registriesRaw) || !Array.isArray(registriesRaw["registries"])) {
    throw new Error("malformed registry.list response from the gateway");
  }
  if (!isRecord(extensionsRaw) || !Array.isArray(extensionsRaw["extensions"])) {
    throw new Error("malformed extension.list response from the gateway");
  }
  const registries = registriesRaw["registries"].filter(isRecord);
  const configured = new Set(
    registries.flatMap((r) => (typeof r["name"] === "string" ? [r["name"]] : [])),
  );
  const orphans = extensionsRaw["extensions"].flatMap((e: unknown) =>
    isRecord(e) &&
    typeof e["id"] === "string" &&
    typeof e["source_registry"] === "string" &&
    !configured.has(e["source_registry"])
      ? [`${stripControl(e["id"])} from "${stripControl(e["source_registry"])}"`]
      : [],
  );
  const lines: string[] = [];
  if (orphans.length > 0) {
    const shown = orphans.slice(0, MAX_LISTED).join(", ");
    const more = orphans.length > MAX_LISTED ? `, +${orphans.length - MAX_LISTED} more` : "";
    lines.push(
      `[warn] Extension registries: ${orphans.length} installed extension(s) come from a registry that is no longer configured and will get no updates (${shown}${more}) — re-add it with nimbus registry add <name> <url>, or remove the extension`,
    );
  }
  for (const r of registries) {
    if (r["stale"] !== true || typeof r["name"] !== "string") continue;
    const name = stripControl(r["name"]);
    const generated =
      typeof r["generatedAt"] === "string" ? stripControl(r["generatedAt"]) : "at an unknown time";
    lines.push(
      `[warn] Extension registries: the index of "${name}" was generated ${generated}, more than 30 days ago — nimbus registry refresh ${name}; a registry that stops publishing can hold back updates`,
    );
  }
  return { lines, exit: lines.length > 0 ? 1 : 0 };
}

const RETRY_CMD = "`nimbus connector migrate retry`";

/**
 * True when a failed migration's error already names `nimbus extension approve <id>` — the
 * gateway's re-approve suffix (`reapproveSuffix`, "... to resume sync"). That row is not fixed by
 * `migrate retry`: re-approving the extension resumes the sync itself, so the owner is shown that
 * one step and not two. The CLI package does not import gateway source, so this matches the
 * command text the suffix carries.
 */
export function namesApproveStep(error: string | null): boolean {
  return error?.includes("`nimbus extension approve ") === true;
}

/**
 * `nimbus doctor`'s connector-migration lines, from a `migration.list` response (Readwise
 * unbundling spec § 7.2): a `[warn]` (exit 1) for a migration awaiting the owner's answer and for
 * one that failed, and a QUIET `[info]` (exit 0) for one the owner declined, naming `migrate retry`
 * as the way to change their mind. Approved rows are silent. Throws on a malformed response; the
 * caller turns that into a `[warn]`.
 */
export function doctorMigrationLines(raw: unknown): { lines: string[]; exit: number } {
  if (!isRecord(raw) || !Array.isArray(raw["migrations"])) {
    throw new Error("malformed migration.list response from the gateway");
  }
  const lines: string[] = [];
  let exit = 0;
  for (const m of raw["migrations"]) {
    if (
      !isRecord(m) ||
      typeof m["id"] !== "string" ||
      typeof m["legacyServiceId"] !== "string" ||
      typeof m["extensionId"] !== "string" ||
      typeof m["state"] !== "string"
    ) {
      throw new Error("malformed migration.list response from the gateway");
    }
    const id = stripControl(m["id"]);
    const legacy = stripControl(m["legacyServiceId"]);
    const ext = stripControl(m["extensionId"]);
    switch (m["state"]) {
      case "awaiting_approval":
        lines.push(
          `[warn] Connector migration: ${legacy} moved out of the built-in set to the extension ${ext}; its sync is paused until you answer — nimbus connector migrate accept ${id} (or decline ${id})`,
        );
        exit = 1;
        break;
      case "failed": {
        const error = typeof m["error"] === "string" ? stripControl(m["error"]) : "unknown error";
        const next =
          error.includes(RETRY_CMD) || namesApproveStep(error) ? "" : ` — run ${RETRY_CMD}`;
        lines.push(
          `[warn] Connector migration: ${legacy} could not be moved to ${ext} and stays paused: ${error}${next}`,
        );
        exit = 1;
        break;
      }
      case "declined":
        lines.push(
          `[info] Connector migration: ${legacy} stays off because moving it to ${ext} was declined (your items are kept) — run ${RETRY_CMD} to change your mind`,
        );
        break;
      default:
        break;
    }
  }
  return { lines, exit };
}

/** A configured trust feed older than this many days earns a doctor warning. */
export const TRUST_FEED_STALE_DAYS = 7;

/**
 * The trust-feed doctor line (trust layer): a `[warn]` when a configured feed was last updated more
 * than `TRUST_FEED_STALE_DAYS` ago, or was configured but never accepted. Nothing when the build has
 * no feed configured.
 */
export function doctorTrustLines(raw: unknown): { lines: string[]; exit: number } {
  if (!isRecord(raw) || raw["configured"] !== true) return { lines: [], exit: 0 };
  const age = raw["ageDays"];
  // Every release follows a feed, so a gateway that has just started has not fetched it yet: that
  // is not a fault until a fetch has been attempted (the baked snapshot applies meanwhile).
  if (age === null && typeof raw["lastAttemptedAt"] !== "number") {
    return {
      lines: [
        "[info] Trust feed: not fetched yet; the first check runs a few seconds after the gateway starts, and the release's snapshot applies until then.",
      ],
      exit: 0,
    };
  }
  if (age === null) {
    return {
      lines: [
        "[warn] Trust feed: never fetched. Revocations and takedowns cannot reach this machine until it is (`nimbus trust refresh`).",
      ],
      exit: 1,
    };
  }
  if (typeof age === "number" && age > TRUST_FEED_STALE_DAYS) {
    return {
      lines: [
        `[warn] Trust feed: last updated ${age} days ago; revocations published since then have not reached this machine (\`nimbus trust refresh\`).`,
      ],
      exit: 1,
    };
  }
  return { lines: [], exit: 0 };
}
