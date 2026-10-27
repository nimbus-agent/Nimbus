/**
 * `nimbus extension report <id>` (marketplace trust layer, spec § 6.11): opens a pre-filled report on
 * the installed extension's SOURCE registry. The destination is that registry's `reportUrl` (from its
 * signed index; the built-in registry's is baked), asked of the gateway for that registry only, so a
 * third-party extension is never reported to Nimbus's repository. For a GitHub issue form the title
 * and body carry PUBLIC metadata only — extension id, version, publisher id, key fingerprint, the
 * source registry's local name, Nimbus version, OS family — never a path, log or config. The URL is
 * printed; on a terminal it opens in the browser only after an explicit yes. Stated bound: the query
 * string reaches github.com when the browser opens it.
 */
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import type { IPCClient } from "../ipc-client/index.ts";

export interface ReportDeps {
  client: IPCClient;
  isTty: boolean;
  /** Asks a yes/no question on the terminal; resolves `true` only for a yes. */
  confirm: (question: string) => Promise<boolean>;
  openUrl: (url: string) => Promise<void>;
  log: (s: string) => void;
  err: (s: string) => void;
  nimbusVersion: string;
  osFamily: string;
}

const USAGE = "Usage: nimbus extension report <id>\n";
const GITHUB_ISSUE_FORM_PATH_RE = /^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+\/issues\/new$/;

class ReportError extends Error {}

const noDestination = (detail: string): ReportError =>
  new ReportError(`ERR_REPORT_NO_DESTINATION: ${detail}`);

type InstalledView = {
  id: string;
  version: string;
  source_registry?: string | null;
  publisher_key_fingerprint?: string | null;
  publisher?: { id: string; key?: string };
};

/** The public facts a report carries about an installed extension. */
interface ReportFacts {
  id: string;
  version: string;
  registry: string;
  publisherId: string;
  fingerprint: string;
}

function factsOf(e: InstalledView): ReportFacts {
  const registry = typeof e.source_registry === "string" ? e.source_registry : undefined;
  if (registry === undefined) {
    throw noDestination(
      `${e.id} was installed from a local path, not a registry; report it to its publisher directly`,
    );
  }
  const key = e.publisher?.key;
  const fingerprint =
    e.publisher_key_fingerprint ??
    (typeof key === "string" ? publisherKeyFingerprint(key) : "unknown");
  return {
    id: e.id,
    version: e.version,
    registry,
    publisherId: e.publisher?.id ?? "(unsigned)",
    fingerprint,
  };
}

async function reportUrlOf(client: IPCClient, f: ReportFacts): Promise<string> {
  let info: { reportUrl?: string | null };
  try {
    info = await client.call<{ reportUrl?: string | null }>("registry.info", {
      id: f.id,
      registry: f.registry,
      reportOnly: true,
    });
  } catch (e) {
    throw noDestination(
      `registry ${f.registry} could not be read for ${f.id} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const url = info.reportUrl;
  if (typeof url !== "string" || url === "") {
    throw noDestination(`registry ${f.registry} names no report destination for its extensions`);
  }
  return url;
}

/** The destination, pre-filled with public metadata when it is a GitHub issue form. */
function prefilled(url: string, f: ReportFacts, deps: ReportDeps): string {
  if (!URL.canParse(url)) return url;
  const form = new URL(url);
  const isIssueForm =
    form.protocol === "https:" &&
    form.host === "github.com" &&
    GITHUB_ISSUE_FORM_PATH_RE.test(form.pathname);
  if (!isIssueForm) return url;
  const body = [
    "<!-- Describe the problem here. Only the public facts below were filled in by Nimbus. -->",
    "",
    "",
    "---",
    `- Extension: ${f.id}@${f.version}`,
    `- Publisher: ${f.publisherId} (key fingerprint ${f.fingerprint})`,
    `- Installed from registry: ${f.registry}`,
    `- Nimbus: ${deps.nimbusVersion} (${deps.osFamily})`,
  ].join("\n");
  // Keep the registry's own query (e.g. `?template=report.yml`) and add the prefill to it.
  form.searchParams.set("title", `Report: ${f.id}@${f.version}`);
  form.searchParams.set("body", body);
  return form.href;
}

/** Exit 0 on success; 2 for a usage error or no destination. */
export async function runExtensionReport(
  args: readonly string[],
  deps: ReportDeps,
): Promise<number> {
  const [id] = args;
  if (id === undefined || args.length !== 1 || id.startsWith("--")) {
    deps.err(USAGE);
    return 2;
  }
  try {
    const out = await deps.client.call<{ extension: InstalledView }>("extension.info", { id });
    const facts = factsOf(out.extension);
    const url = prefilled(await reportUrlOf(deps.client, facts), facts, deps);
    deps.log(`Report ${facts.id}@${facts.version} at:\n${url}\n`);
    if (deps.isTty && (await deps.confirm("Open it in your browser? [y/N] "))) {
      await deps.openUrl(url);
    }
    return 0;
  } catch (e) {
    if (e instanceof ReportError) {
      deps.err(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
