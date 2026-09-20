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
      const v = tail[i + 1];
      if (v === undefined || v === "") throw new Error(USAGE);
      project = v;
      i += 1;
    } else throw new Error(USAGE);
  }
  return { json, replace, sources: sources.length === 0 ? undefined : sources, project };
}

function describeFinding(f: FindingWire): string {
  const what =
    f.source === "gh"
      ? `${f.host ?? "github.com"}  ${(f.accounts ?? []).join(", ")}`
      : f.source === "aws"
        ? `profiles: ${(f.profiles ?? []).join(", ")}`
        : f.source === "gcloud"
          ? `${f.account ?? ""}  project: ${f.project ?? "(none)"}`
          : `${f.kubeconfig ?? ""}  contexts: ${(f.contexts ?? []).join(", ")}`;
  const state =
    f.status === "available"
      ? f.alreadyConfigured
        ? "available (already configured)"
        : "available"
      : `${f.status.replaceAll("_", " ")}${f.reason === undefined ? "" : ` — ${f.reason}`}`;
  return `  ${f.source.padEnd(8)} ${what}  ·  ${state}`;
}

/** gcloud's `needs_project` is offerable too — an active login with no default project just needs
 * the owner to name one. Scoped to gcloud specifically, mirroring the gateway's own `usable()`
 * carve-out (`adopt-local-auth.ts`) — `needs_project` has no meaning for gh/aws/kubectl. */
function adoptable(f: FindingWire, replace: boolean): boolean {
  const offerable =
    f.status === "available" || (f.source === "gcloud" && f.status === "needs_project");
  return offerable && (replace || !f.alreadyConfigured);
}

/** Candidates for the numbered pick, and the one Enter chooses. */
function choices(f: FindingWire): {
  key: "account" | "profile" | "context";
  items: string[];
  preselect: number;
} {
  if (f.source === "gh") {
    const items = f.accounts ?? [];
    return { key: "account", items, preselect: Math.max(0, items.indexOf(f.activeAccount ?? "")) };
  }
  if (f.source === "aws") {
    const items = f.profiles ?? [];
    return { key: "profile", items, preselect: Math.max(0, items.indexOf("default")) };
  }
  const items = f.contexts ?? [];
  return { key: "context", items, preselect: Math.max(0, items.indexOf(f.currentContext ?? "")) };
}

async function chooseOne(
  f: FindingWire,
  deps: ConnectorDetectDeps,
  opts: Opts,
): Promise<AdoptParams | null> {
  if (f.source === "gcloud") {
    const project =
      f.project ??
      opts.project ??
      (await deps.ask("  gcloud: which GCP project id? [Enter = skip] "));
    return project === "" ? null : { source: "gcloud", project, replace: false };
  }
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
  if (c.key === "account") return { source: f.source, account: chosen, replace: false };
  if (c.key === "profile") return { source: f.source, profile: chosen, replace: false };
  return { source: f.source, context: chosen, replace: false };
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
    if (f.status === "available" && f.alreadyConfigured && !opts.replace) {
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
