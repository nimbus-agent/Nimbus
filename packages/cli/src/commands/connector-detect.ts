import type { IPCClient } from "../ipc-client/index.ts";
import { readLine } from "../lib/read-line.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import type { CliPlatformPaths } from "../paths.ts";

type Source = "gh" | "aws" | "kubectl" | "gcloud";
const SOURCES: readonly Source[] = ["gh", "aws", "kubectl", "gcloud"];
const SERVICE_NAME: Readonly<Record<Source, string>> = {
  gh: "github",
  aws: "aws",
  kubectl: "kubernetes",
  gcloud: "gcp",
};

/** The gateway's `LocalAuthFinding`, restated for the IPC boundary (no source imports). */
export interface FindingWire {
  source: Source;
  status: string;
  reason?: string;
  alreadyConfigured: boolean;
  host?: string;
  accounts?: string[];
  activeAccount?: string | null;
  profiles?: string[];
  kubeconfig?: string;
  contexts?: string[];
  currentContext?: string | null;
  account?: string | null;
  project?: string | null;
}

export type AdoptParams = {
  source: Source;
  account?: string;
  profile?: string;
  context?: string;
  project?: string;
  replace: boolean;
};

export type AdoptOutcomeWire =
  | {
      ok: true;
      source: string;
      service: string;
      verified: "verified" | "unverified" | null;
      scopes: string[];
    }
  | { status: "rejected"; reason?: string };

export interface ConnectorDetectDeps {
  detect(sources: readonly string[] | undefined): Promise<FindingWire[]>;
  adopt(params: AdoptParams): Promise<AdoptOutcomeWire>;
  readonly interactive: boolean;
  ask(question: string): Promise<string>;
  log(line: string): void;
}

const USAGE =
  "Usage: nimbus connector detect [--json] [--source gh|aws|kubectl|gcloud]... [--replace] [--project <id>]";

interface Opts {
  readonly json: boolean;
  readonly replace: boolean;
  readonly sources: readonly Source[] | undefined;
  readonly project: string | undefined;
}

function parseOpts(tail: readonly string[]): Opts {
  let json = false;
  let replace = false;
  let project: string | undefined;
  const sources: Source[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === "--json") json = true;
    else if (a === "--replace") replace = true;
    else if (a === "--source") {
      const v = tail[i + 1];
      if (v === undefined || !(SOURCES as readonly string[]).includes(v)) throw new Error(USAGE);
      sources.push(v as Source);
      i += 1;
    } else if (a === "--project") {
      // Trimmed here for the same reason `readLine` trims the interactive answer (below) — a
      // whitespace-only value is not a project id, and the two paths must agree on what counts
      // as "empty" rather than one silently forwarding " " to the gateway.
      const v = tail[i + 1]?.trim();
      if (v === undefined || v === "") throw new Error(USAGE);
      project = v;
      i += 1;
    } else throw new Error(USAGE);
  }
  return { json, replace, sources: sources.length === 0 ? undefined : sources, project };
}

/**
 * The rendered "what" half of a finding's line — one arm per `Source`. A `switch` rather than a
 * ternary chain so a fifth source added to `Source` without its own case here fails
 * `bun run typecheck` (the `never` assignment in `default`) instead of silently falling through
 * to the last arm — which is exactly how a gcloud finding once rendered as `contexts:` before
 * `Source` included `"gcloud"` at all.
 */
function findingWhat(f: FindingWire): string {
  switch (f.source) {
    case "gh":
      return `${f.host ?? "github.com"}  ${(f.accounts ?? []).join(", ")}`;
    case "aws":
      return `profiles: ${(f.profiles ?? []).join(", ")}`;
    case "kubectl":
      return `${f.kubeconfig ?? ""}  contexts: ${(f.contexts ?? []).join(", ")}`;
    case "gcloud":
      return `${f.account ?? ""}  project: ${f.project ?? "(none)"}`;
    default: {
      const _exhaustive: never = f.source;
      return _exhaustive;
    }
  }
}

function describeFinding(f: FindingWire): string {
  const what = findingWhat(f);
  const state =
    f.status === "available"
      ? f.alreadyConfigured
        ? "available (already configured)"
        : "available"
      : `${f.status.replaceAll("_", " ")}${f.reason === undefined ? "" : ` — ${f.reason}`}`;
  return `  ${f.source.padEnd(8)} ${what}  ·  ${state}`;
}

/**
 * Whether this finding's STATUS is one Nimbus can ever offer, ignoring `alreadyConfigured`/
 * `replace` — the one fact `adoptable()` and the "already configured" hint below must agree on.
 * They used to check this independently and drifted: `adoptable()` learned to offer gcloud's
 * `needs_project`, the hint did not, so a re-adopt-after-`gcloud config unset project` finding
 * was correctly withheld from the offer list but printed no explanation why. Shared here so the
 * two cannot drift again — same discipline as this file's `GCP_PROJECT_ID` validator, which lives
 * once on the gateway side rather than as two regexes that could disagree.
 *
 * gcloud's `needs_project` counts as offerable — an active login with no default project just
 * needs the owner to name one. Scoped to gcloud specifically, mirroring the gateway's own
 * `usable()` carve-out (`adopt-local-auth.ts`) — `needs_project` has no meaning for gh/aws/kubectl.
 */
function isOfferableStatus(f: FindingWire): boolean {
  return f.status === "available" || (f.source === "gcloud" && f.status === "needs_project");
}

function adoptable(f: FindingWire, replace: boolean): boolean {
  return isOfferableStatus(f) && (replace || !f.alreadyConfigured);
}

/** Candidates for the numbered pick, and the one Enter chooses. gcloud never reaches this —
 * `chooseOne` handles it directly, before calling `choices()` — but the `"gcloud"` case still has
 * to be handled explicitly (not folded into `default`) for the exhaustiveness check below to mean
 * anything: without it, `default` would already be reachable today and the `never` assignment
 * would never catch a REAL new member. */
function choices(f: FindingWire): {
  key: "account" | "profile" | "context";
  items: string[];
  preselect: number;
} {
  switch (f.source) {
    case "gh": {
      const items = f.accounts ?? [];
      return {
        key: "account",
        items,
        preselect: Math.max(0, items.indexOf(f.activeAccount ?? "")),
      };
    }
    case "aws": {
      const items = f.profiles ?? [];
      return { key: "profile", items, preselect: Math.max(0, items.indexOf("default")) };
    }
    case "kubectl": {
      const items = f.contexts ?? [];
      return {
        key: "context",
        items,
        preselect: Math.max(0, items.indexOf(f.currentContext ?? "")),
      };
    }
    case "gcloud":
      throw new Error("choices() does not support gcloud — chooseOne handles it directly");
    default: {
      const _exhaustive: never = f.source;
      throw new Error(_exhaustive);
    }
  }
}

/** The generic numbered-pick path shared by gh/aws/kubectl. */
async function chooseFromList(
  f: FindingWire,
  deps: ConnectorDetectDeps,
): Promise<AdoptParams | null> {
  const c = choices(f);
  let chosen = c.items[c.preselect];
  if (c.items.length > 1) {
    deps.log(`  ${f.source}: which ${c.key}?`);
    c.items.forEach((item, i) => {
      deps.log(`    ${String(i + 1)}) ${item}${i === c.preselect ? "  (default)" : ""}`);
    });
    const answer = await deps.ask(`  [Enter = ${String(c.preselect + 1)}, 0 = skip] `);
    if (answer === "0") return null;
    if (answer !== "") {
      const n = Number(answer);
      chosen = Number.isInteger(n) && n >= 1 && n <= c.items.length ? c.items[n - 1] : undefined;
      if (chosen === undefined) {
        deps.log("  Not a choice — skipping.");
        return null;
      }
    }
  }
  if (chosen === undefined) return null;
  // `replace` is set by the caller from --replace — one source of truth. Built per key, not with a
  // computed property, which would widen the object past `AdoptParams`.
  switch (c.key) {
    case "account":
      return { source: f.source, account: chosen, replace: false };
    case "profile":
      return { source: f.source, profile: chosen, replace: false };
    case "context":
      return { source: f.source, context: chosen, replace: false };
    default: {
      const _exhaustive: never = c.key;
      return _exhaustive;
    }
  }
}

/**
 * The `Source`-level dispatch, itself exhaustive: a fifth source added without a case here (or in
 * `findingWhat`/`choices` above) fails `bun run typecheck`, not just a manual review.
 */
async function chooseOne(
  f: FindingWire,
  deps: ConnectorDetectDeps,
  opts: Opts,
): Promise<AdoptParams | null> {
  switch (f.source) {
    case "gcloud": {
      const project =
        f.project ??
        opts.project ??
        (await deps.ask("  gcloud: which GCP project id? [Enter = skip] "));
      return project === "" ? null : { source: "gcloud", project, replace: false };
    }
    case "gh":
    case "aws":
    case "kubectl":
      return chooseFromList(f, deps);
    default: {
      const _exhaustive: never = f.source;
      return _exhaustive;
    }
  }
}

function referenceHint(p: AdoptParams): string {
  if (p.source === "aws") {
    return `  The aws CLI must be able to authenticate profile ${p.profile ?? ""} when Nimbus syncs — run \`aws sso login --profile ${p.profile ?? ""}\` if it uses SSO.`;
  }
  if (p.source === "gcloud") {
    return "  gcloud must be logged in as this account when Nimbus syncs — run `gcloud auth login` if the session expires.";
  }
  return `  kubectl must be able to reach context ${p.context ?? ""} when Nimbus syncs (refresh its login if it uses an exec plugin).`;
}

function reportOutcome(p: AdoptParams, out: AdoptOutcomeWire, deps: ConnectorDetectDeps): void {
  if ("status" in out) {
    deps.log("  Skipped — not approved.");
    return;
  }
  const verified =
    out.verified === "verified"
      ? "verified"
      : out.verified === "unverified"
        ? "stored, NOT verified"
        : "stored";
  deps.log(`  ✓ ${out.service} connected (${verified}).`);
  if (p.source === "gh") {
    deps.log(
      `  Token scopes: ${out.scopes.length === 0 ? "(not reported)" : out.scopes.join(", ")}`,
    );
  } else {
    deps.log(referenceHint(p));
  }
}

export function summarizeLocalLogins(findings: readonly FindingWire[]): string | null {
  const n = findings.filter((f) => adoptable(f, false)).length;
  if (n === 0) return null;
  return `Found ${String(n)} local login${n === 1 ? "" : "s"} Nimbus can reuse — run: nimbus connector detect`;
}

export async function runConnectorDetect(
  tail: string[],
  deps: ConnectorDetectDeps = defaultConnectorDetectDeps(),
): Promise<void> {
  const opts = parseOpts(tail);
  const findings = await deps.detect(opts.sources);
  if (opts.json) {
    deps.log(JSON.stringify(findings, null, 2));
    return;
  }
  deps.log("Local logins Nimbus can reuse:");
  for (const f of findings) deps.log(describeFinding(f));
  const offer = findings.filter((f) => adoptable(f, opts.replace));
  for (const f of findings) {
    if (isOfferableStatus(f) && f.alreadyConfigured && !opts.replace) {
      deps.log(
        `  ${SERVICE_NAME[f.source]} is already configured — pass --replace to overwrite it.`,
      );
    }
  }
  if (offer.length === 0) return;
  if (!deps.interactive) {
    deps.log("Run `nimbus connector detect` in a terminal to connect these.");
    return;
  }
  for (const f of offer) {
    const params = await chooseOne(f, deps, opts);
    if (params === null) continue;
    const withReplace = { ...params, replace: opts.replace };
    deps.log(`Connecting ${f.source} — approve the prompt to continue.`);
    try {
      reportOutcome(withReplace, await deps.adopt(withReplace), deps);
    } catch (e) {
      deps.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function defaultConnectorDetectDeps(paths?: CliPlatformPaths): ConnectorDetectDeps {
  const ipcOpts = { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS };
  return {
    detect: (sources) =>
      withGatewayIpc(
        (c: IPCClient) =>
          c.call<FindingWire[]>(
            "connector.detectLocalAuth",
            sources === undefined ? {} : { sources },
          ),
        paths,
        ipcOpts,
      ),
    // `consent: prompt` — the gateway's HITL prompt IS the one keypress; never auto-approve here.
    adopt: (params) =>
      withGatewayIpc(
        (c: IPCClient) => c.call<AdoptOutcomeWire>("connector.adoptLocalAuth", params),
        paths,
        { ...ipcOpts, consent: { kind: "prompt" } },
      ),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: (q) => readLine(q),
    log: (l) => console.log(l),
  };
}
