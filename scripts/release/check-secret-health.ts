import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditCredentials, type InventoryStatus } from "./credential-audit";
import { enumerateSecrets } from "./credential-enumerate";
import { CREDENTIAL_REGISTRY, HARD_DEADLINE_CRITICAL_DAYS } from "./credential-registry";
import { createGitHubApi, type GitHubApi } from "./gh-api.ts";
import { closeHealthIssue, openOrUpdateHealthIssue } from "./open-health-issue.ts";

export type PatStrategy =
  | { readonly kind: "repo-write"; readonly targetRepos: readonly string[] }
  | { readonly kind: "scopes"; readonly required: string }
  | { readonly kind: "alive" };
export type PatStatus = "ok" | "dead" | "insufficient" | "indeterminate" | "not-configured";
export type CertStatus = "ok" | "expiring" | "expired" | "indeterminate" | "not-configured";

export function classifyPatProbe(
  strategy: PatStrategy,
  probe: { status: number; scopes: string | null; push?: boolean },
): PatStatus {
  if (probe.status === 401) return "dead";
  if (probe.status !== 200) return "indeterminate";
  if (strategy.kind === "repo-write") return probe.push === true ? "ok" : "insufficient";
  if (strategy.kind === "scopes") {
    const have = (probe.scopes ?? "").split(",").map((s) => s.trim());
    return have.includes(strategy.required) ? "ok" : "insufficient";
  }
  return "ok";
}

/**
 * The release-bot GitHub App health probe: a scoped-mint step (`actions/create-github-app-token`)
 * runs before this check, and its `steps.<id>.outcome` is passed in via `APP_MINT_STATUS`.
 * Fail-closed — only an explicit "success" outcome is "ok"; any other outcome (`failure`,
 * `skipped`, unset/empty) is "dead", so a missing App secret or a skipped mint step alerts
 * rather than silently passing.
 */
export function classifyAppMint(outcome: string): PatStatus {
  return outcome === "success" ? "ok" : "dead";
}

/** Guard against malformed/localized binary output — an unparseable date must be indeterminate, never a false "ok" (plan-review #2). */
export function safeParseDate(dateStr: string): Date | null {
  const d = new Date(dateStr.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function evaluateCertExpiry(
  notAfter: Date | null,
  now: Date,
  thresholdDays: number,
): CertStatus {
  if (notAfter === null || Number.isNaN(notAfter.getTime())) return "indeterminate";
  const days = (notAfter.getTime() - now.getTime()) / 86_400_000;
  if (days < 0) return "expired";
  if (days <= thresholdDays) return "expiring";
  return "ok";
}

export type ProvenanceStatus = "ok" | "missing-provenance" | "source-mismatch" | "indeterminate";

/**
 * The `verify-npm-provenance` composite action runs in monitor mode before this
 * check and its `steps.<id>.outputs.status` is passed in via env — the same
 * shape as the App-mint probe above. Fail closed: an unset value means the step
 * never ran, and an unrecognised value is never silently "ok".
 *
 * An empty string is NOT the same situation as an absent PAT/cert secret
 * (`not-configured` there is a genuine, intentional healthy state). Here it
 * means the probe never reported at all: a
 * renamed step id, a skipped step, or an action that exits before writing its
 * output all interpolate to "" with no workflow error. `not-configured` sits
 * in neither the `hard` nor `warn` set in `summarize`, so returning it here
 * took the issue-closing "healthy" branch for a probe that told us nothing —
 * a false `ok` for "we have no idea". Map it to `indeterminate` instead, so
 * it lands in the warn path (review finding #1).
 */
export function classifyProvenanceOutcome(status: string): ProvenanceStatus {
  if (status === "") return "indeterminate";
  if (
    status === "ok" ||
    status === "missing-provenance" ||
    status === "source-mismatch" ||
    status === "indeterminate"
  ) {
    return status;
  }
  return "indeterminate";
}

/**
 * Composes a provenance row's `detail` from the resolved version and the
 * `verify-npm-provenance` action's own `detail` output (e.g. `repository
 * https://github.com/attacker/x != https://github.com/nimbus-agent/nimbus-sdk`
 * or `no SLSA provenance predicate — publish degraded`). Without this, the
 * single most alarming row this monitor can produce (`source-mismatch`) filed
 * an issue naming neither the version that failed nor the reason — the two
 * facts an on-call reader actually needs.
 *
 * When both inputs are empty (the probe never ran — the workflow's `if:`
 * guard skips the probe step when version resolution failed) this returns the
 * original static placeholder, so a skipped probe still classifies exactly as
 * it did before this composition existed.
 */
export function composeProvenanceDetail(version: string, actionDetail: string): string {
  if (version === "" && actionDetail === "") return "latest published version";
  const versionPart = version === "" ? "unknown version" : `v${version}`;
  return actionDetail === "" ? versionPart : `${versionPart}: ${actionDetail}`;
}

export type HealthStatus = PatStatus | CertStatus | ProvenanceStatus | InventoryStatus;

export interface HealthRow {
  readonly name: string;
  readonly kind: "pat" | "cert" | "provenance" | "inventory";
  readonly status: HealthStatus;
  readonly detail: string;
}

/** How loudly a row speaks. `hard` is the only one that exits non-zero. */
export type Severity = "hard" | "warn" | "healthy";

/**
 * Every status any row kind can carry. Its completeness against the union is
 * proven at COMPILE time by `HEALTH_STATUS_CATALOGUE_COMPLETE` below, so this
 * list cannot silently fall behind a new status.
 */
export const ALL_HEALTH_STATUSES = [
  "ok",
  "dead",
  "insufficient",
  "indeterminate",
  "not-configured",
  "expiring",
  "expired",
  "missing-provenance",
  "source-mismatch",
  "missing",
  "present",
  "undocumented",
  "stale",
  "deadline-approaching",
  "deadline-critical",
  "visibility-drift",
  "audit-overdue",
] as const satisfies readonly HealthStatus[];

/**
 * `true` only when `ALL_HEALTH_STATUSES` covers the whole `HealthStatus` union.
 * Adding a status to any of the four unions without cataloguing it here makes
 * this type `false`, and the `= true` initializer stops compiling.
 */
export const HEALTH_STATUS_CATALOGUE_COMPLETE: [
  Exclude<HealthStatus, (typeof ALL_HEALTH_STATUSES)[number]>,
] extends [never]
  ? true
  : false = true;

/**
 * An unrecognised status is a bug, not a healthy credential. The `never`
 * parameter makes omitting a case from `severityOf` a COMPILE error; the body
 * covers the runtime case where a value reached us past the type system (a
 * renamed composite-action output, a hand-built row) and fails it closed.
 */
function unclassifiedSeverity(status: never): Severity {
  console.error(
    `check-secret-health: unclassified status ${JSON.stringify(status)} — treating as a hard failure`,
  );
  return "hard";
}

/**
 * The single place a status becomes a verdict.
 *
 * The load-bearing split is between the two ways a credential can be in
 * trouble, which an operator must never confuse:
 *
 * - **Rejected** (`dead`, `insufficient`, `expired`, and the provenance
 *   verdicts) — a live probe just came back bad. Something IS broken. Hard.
 * - **Dated** (`deadline-approaching`, `expiring`, `stale`, …) — a calendar in
 *   `credential-registry.ts` says this will break later. Nothing is broken yet.
 *   Warn — with ONE exception: `deadline-critical`, the point at which the
 *   remaining runway is shorter than the time a replacement takes to arrange
 *   (`HARD_DEADLINE_CRITICAL_DAYS`), where a date becomes an emergency.
 *
 * `dead` is hard unconditionally and is never softened by anything in this
 * function — that is the guarantee the deadline split must not erode.
 */
export function severityOf(status: HealthStatus): Severity {
  switch (status) {
    // A provider said no, a signature did not verify, or a credential that must
    // not exist does. Broken now.
    case "dead":
    case "insufficient":
    case "expired":
    case "missing-provenance":
    case "source-mismatch":
    case "present":
    // Inventory: a credential nobody recorded is a credential nobody assessed.
    case "undocumented":
    case "missing":
    // A recorded deadline whose replacement runway has run out.
    case "deadline-critical":
      return "hard";

    // Dated, inconclusive, or hygiene. Real work, but nothing is rejected.
    case "expiring":
    case "indeterminate":
    case "stale":
    case "deadline-approaching":
    case "visibility-drift":
    case "audit-overdue":
      return "warn";

    // `not-configured` is healthy only because every credential that may be
    // legitimately unset is declared `optional`/`forbidden` in the registry; a
    // `required` one that is absent surfaces as `missing`, above.
    case "ok":
    case "not-configured":
      return "healthy";

    default:
      return unclassifiedSeverity(status);
  }
}

export const BROKEN_HEADING = "## ❌ BROKEN — rejected, absent, or out of runway";
export const SCHEDULED_HEADING = "## 🟡 SCHEDULED — dated work; nothing here is broken";
export const HEALTHY_HEADING = "## ✅ Healthy";

/**
 * Why the issue body is sectioned rather than one flat table.
 *
 * A standing warning (an approaching deadline is one for up to 76 days) keeps
 * this issue permanently open. In a flat 45-row table, a credential that died
 * overnight arrives as one more row among forty-five — the same shape, the same
 * place, one word different in the status column. Sections make the two
 * outcomes structurally different: a newly-dead credential appears under a
 * heading that was empty, and an approaching expiry can never appear there.
 */
const SECTIONS: readonly { severity: Severity; heading: string; blurb: string }[] = [
  {
    severity: "hard",
    heading: BROKEN_HEADING,
    blurb:
      "Every row here either failed a **live probe** (a provider rejected the credential) or has run out of the lead time its replacement needs. This section is the only reason this job ever exits non-zero.",
  },
  {
    severity: "warn",
    heading: SCHEDULED_HEADING,
    blurb: `No row here has been rejected by anything. These are calendar and hygiene signals with runway left — a deadline row moves up into BROKEN at ${HARD_DEADLINE_CRITICAL_DAYS} days out. The job still succeeds.`,
  },
  { severity: "healthy", heading: HEALTHY_HEADING, blurb: "" },
];

const VOCABULARY_NOTE = [
  "> **Reading this table.** `dead` / `insufficient` / `expired` come from a **live probe**:",
  "> a provider rejected the credential just now. `deadline-approaching` /",
  "> `deadline-critical` come from the **calendar** in",
  "> `scripts/release/credential-registry.ts`: the credential still authenticates, and the",
  "> date is when it is expected to stop. They are different findings and never share a",
  "> section.",
  ">",
  "> PATs are checked dead/alive + authorization only — fine-grained PAT *expiry dates* are",
  "> not exposed by the API, so a dead PAT is caught within one weekly cycle, not ahead.",
  "> Certs and registered hard deadlines get true N-days-ahead warning.",
].join("\n");

function renderTable(rows: readonly HealthRow[]): string {
  return [
    "| Credential | Kind | Status | Detail |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.kind} | ${r.status} | ${r.detail} |`),
  ].join("\n");
}

export function summarize(rows: readonly HealthRow[]): {
  hasHardFailure: boolean;
  hasWarning: boolean;
  table: string;
  state: string;
} {
  // A `Record` keyed by the `Severity` union rather than a Map: indexing is
  // total, so there is no `?.` on the push and therefore no path — present or
  // future — where a row is silently dropped instead of being reported. Every
  // input row lands in exactly one bucket.
  const hard: HealthRow[] = [];
  const warn: HealthRow[] = [];
  const healthy: HealthRow[] = [];
  const bySeverity: Record<Severity, HealthRow[]> = { hard, warn, healthy };
  for (const r of rows) bySeverity[severityOf(r.status)].push(r);

  const parts: string[] = [
    `**BROKEN: ${hard.length} · scheduled: ${warn.length} · healthy: ${healthy.length}**`,
  ];
  for (const section of SECTIONS) {
    const sectionRows = bySeverity[section.severity];
    // The BROKEN and SCHEDULED headings are rendered even when empty, so the
    // 0 → 1 transition is a visible change in the body rather than a new row
    // buried mid-table. The healthy section is dropped when empty because "0
    // healthy" carries no signal.
    if (sectionRows.length === 0 && section.severity === "healthy") continue;
    parts.push(
      section.severity === "healthy"
        ? `${section.heading} (${sectionRows.length})`
        : `${section.heading} (${sectionRows.length})\n\n${section.blurb}`,
    );
    parts.push(
      sectionRows.length === 0
        ? "_None._"
        : // Healthy rows are the bulk of the body and none of the signal;
          // collapsing them keeps the two actionable sections above the fold.
          section.severity === "healthy"
          ? `<details><summary>Show ${sectionRows.length} healthy rows</summary>\n\n${renderTable(sectionRows)}\n\n</details>`
          : renderTable(sectionRows),
    );
  }
  parts.push(VOCABULARY_NOTE);

  const state = rows
    .map((r) => `${r.name}=${r.status}`)
    .sort()
    .join(";");
  return {
    hasHardFailure: hard.length > 0,
    hasWarning: warn.length > 0,
    table: parts.join("\n\n"),
    state,
  };
}

// --- GitHub Actions annotations ---
//
// Workflow commands are line-delimited and `::`-delimited, so any interpolated
// text must be escaped or a row could terminate the command and inject its own.
// Registry notes are ours, but secret NAMES arrive from the GitHub API, so this
// is applied unconditionally. Escape `%` FIRST or the later replacements'
// own percent signs get double-encoded.
function escapeAnnotationData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeAnnotationProperty(value: string): string {
  return escapeAnnotationData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/**
 * One annotation per non-healthy row, at a level that matches its severity.
 *
 * The Actions run page groups annotations by level, so the same
 * expiring-vs-dead separation the issue body makes in sections is also made in
 * the run summary: an approaching deadline is a yellow warning that leaves the
 * job green, a rejected credential is a red error.
 */
export function annotationsFor(rows: readonly HealthRow[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    const severity = severityOf(r.status);
    if (severity === "healthy") continue;
    const level = severity === "hard" ? "error" : "warning";
    const title = severity === "hard" ? "BROKEN credential" : "Scheduled credential work";
    lines.push(
      `::${level} title=${escapeAnnotationProperty(`${title}: ${r.name}`)}::${escapeAnnotationData(
        `${r.name} — ${r.status} — ${r.detail}`,
      )}`,
    );
  }
  return lines;
}

/**
 * The `detail` column for a probed PAT.
 *
 * A `dead` row is the single most urgent thing this monitor can say, and the
 * bare strategy kind ("alive", "scopes") said none of it. Both loud outcomes now
 * name their own provenance in words, so the row still reads correctly when it
 * is quoted out of the table — the mirror of what the deadline details do.
 */
export function describePatOutcome(status: PatStatus, strategy: PatStrategy): string {
  if (status === "dead") {
    return `${strategy.kind} probe: the provider REJECTED this credential — it is revoked or expired NOW`;
  }
  if (status === "insufficient") {
    return `${strategy.kind} probe: authenticates, but lacks the authorization the release path needs`;
  }
  return strategy.kind;
}

// --- I/O orchestration (injected cert decoders so tests never spawn gpg/openssl) ---
export type CertDecoder = (secretEnvVar: string, passwordEnvVar: string) => Promise<Date | null>;

export async function runSecretHealth(deps: {
  api: GitHubApi;
  now: Date;
  thresholdDays: number;
  pats: readonly { env: string; token: string | undefined; strategy: PatStrategy }[];
  certs: readonly {
    name: string;
    secretEnv: string;
    passwordEnv: string;
    present: boolean;
    decode: CertDecoder;
  }[];
  /** Pre-classified rows (e.g. the App-mint health probe) merged in alongside the PAT/cert rows. */
  extraRows?: readonly HealthRow[];
}): Promise<{ hardFailure: boolean }> {
  const rows: HealthRow[] = [...(deps.extraRows ?? [])];
  for (const p of deps.pats) {
    if (!p.token) {
      rows.push({ name: p.env, kind: "pat", status: "not-configured", detail: "unset" });
      continue;
    }
    try {
      const probe = await deps.api.probeToken(p.token);
      let status: PatStatus;
      if (p.strategy.kind === "repo-write" && probe.status === 200) {
        // Authenticate each repo-permission call with the PAT under test — NOT the runner's
        // github.token (which is contents:read here and would falsely report push:false). (plan-review #1)
        // Authz is required on ALL target repos (T4); a repo whose perms lookup errors makes
        // the whole result inconclusive rather than a false "insufficient" (T6).
        let push: boolean | undefined = true;
        for (const repo of p.strategy.targetRepos) {
          const perms = await deps.api.getRepoPermissions(repo, p.token);
          if (!("push" in perms)) {
            push = undefined;
            break;
          }
          if (perms.push !== true) push = false;
        }
        status =
          push === undefined
            ? "indeterminate"
            : classifyPatProbe(p.strategy, { status: probe.status, scopes: probe.scopes, push });
      } else {
        status = classifyPatProbe(p.strategy, { status: probe.status, scopes: probe.scopes });
      }
      rows.push({
        name: p.env,
        kind: "pat",
        status,
        detail: describePatOutcome(status, p.strategy),
      });
    } catch {
      rows.push({ name: p.env, kind: "pat", status: "indeterminate", detail: "probe error" });
    }
  }
  for (const c of deps.certs) {
    if (!c.present) {
      rows.push({ name: c.name, kind: "cert", status: "not-configured", detail: "unset" });
      continue;
    }
    let notAfter: Date | null = null;
    try {
      notAfter = await c.decode(c.secretEnv, c.passwordEnv);
    } catch {
      notAfter = null;
    }
    const status = evaluateCertExpiry(notAfter, deps.now, deps.thresholdDays);
    rows.push({
      name: c.name,
      kind: "cert",
      status,
      detail: notAfter
        ? `${Math.round((notAfter.getTime() - deps.now.getTime()) / 86_400_000)}d`
        : "undecodable",
    });
  }
  const s = summarize(rows);
  if (s.hasHardFailure || s.hasWarning) {
    await openOrUpdateHealthIssue(deps.api, {
      key: "secret-health",
      title: "🔑 Release secret-health alert",
      body: s.table,
      state: s.state,
    });
  } else {
    await closeHealthIssue(
      deps.api,
      "secret-health",
      "✅ All release credentials healthy — closing.",
    );
  }
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) await Bun.write(summaryPath, `# Secret health\n\n${s.table}\n`);
  // Annotations before the table: on the run page they surface at the top of
  // the job, separated by level, so "expiring" and "dead" are distinguishable
  // without opening the issue at all.
  for (const line of annotationsFor(rows)) console.log(line);
  console.log(s.table);
  return { hardFailure: s.hasHardFailure };
}

// --- Real cert decoders ---
//
// Constraints (never relaxed): secrets NEVER touch argv. Base64/armored payloads are
// decoded to a 0600 temp file under $RUNNER_TEMP (falling back to os.tmpdir()); the PKCS#12
// password flows in only via `openssl ... -passin env:<VAR>`, i.e. through the child's
// environment, never as a command-line argument. The GPG import + list-keys read is
// metadata-only and needs no passphrase at all (see decodeGpgExpiry). Any non-zero exit,
// missing binary, or parse miss returns null — the caller maps that to "indeterminate",
// never a false "expired"/"ok" (plan-review #2/#3).

function releaseTempRoot(): string {
  return process.env["RUNNER_TEMP"] ?? tmpdir();
}

async function decodeGpgExpiry(secretEnv: string, _passwordEnv: string): Promise<Date | null> {
  const gpgBin = Bun.which("gpg");
  if (gpgBin === null) return null;
  const armoredKey = process.env[secretEnv];
  if (armoredKey === undefined || armoredKey.length === 0) return null;

  const gnupgHome = join(releaseTempRoot(), `nimbus-gnupg-${crypto.randomUUID()}`);
  try {
    mkdirSync(gnupgHome, { recursive: true, mode: 0o700 });
    const env = { ...process.env, GNUPGHOME: gnupgHome };

    // import + list-keys are metadata-only — no passphrase needed; avoids sharing stdin
    // between passphrase and key. Only the armored key is piped on stdin.
    const importProc = Bun.spawn([gpgBin, "--batch", "--import"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env,
    });
    importProc.stdin.write(armoredKey);
    await importProc.stdin.end();
    const importCode = await importProc.exited;
    if (importCode !== 0) return null;

    const listProc = Bun.spawn([gpgBin, "--batch", "--with-colons", "--list-keys"], {
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
    const [listCode, out] = await Promise.all([
      listProc.exited,
      new Response(listProc.stdout).text(),
    ]);
    if (listCode !== 0) return null;

    // Targets the single signing subkey (GPG_SIGNING_SUBKEY): returns the first `sub:`
    // record with a decodable expiration — a documented single-subkey assumption.
    for (const line of out.split("\n")) {
      const fields = line.split(":");
      if (fields[0] !== "sub") continue;
      // gpg --with-colons: type:validity:length:algo:keyid:creation:expiration:... —
      // expiration is field 7 (0-based index 6), a Unix-epoch-seconds value.
      const expiration = fields[6];
      if (expiration === undefined || expiration.length === 0) continue;
      const epochSeconds = Number(expiration);
      if (Number.isNaN(epochSeconds)) continue;
      const date = new Date(epochSeconds * 1000);
      if (Number.isNaN(date.getTime())) continue;
      return date;
    }
    return null;
  } catch {
    return null;
  } finally {
    rmSync(gnupgHome, { recursive: true, force: true });
  }
}

async function decodePkcs12Expiry(secretEnv: string, passwordEnv: string): Promise<Date | null> {
  const opensslBin = Bun.which("openssl");
  if (opensslBin === null) return null;
  const base64Payload = process.env[secretEnv];
  if (base64Payload === undefined || base64Payload.length === 0) return null;

  const tmp = join(releaseTempRoot(), `nimbus-cert-${crypto.randomUUID()}.p12`);
  try {
    const bytes = Buffer.from(base64Payload, "base64");
    // Pre-create the file at 0600 before any bytes land, so the decoded cert material
    // is never briefly world/group-readable at the umask default.
    writeFileSync(tmp, "", { mode: 0o600 });
    await Bun.write(tmp, bytes);

    // Password never reaches argv: `-passin env:<passwordEnv>` reads it from the
    // child's environment (already inherited — we don't re-inject it).
    const pkcs12Proc = Bun.spawn(
      [
        opensslBin,
        "pkcs12",
        "-in",
        tmp,
        "-passin",
        `env:${passwordEnv}`,
        "-nokeys",
        "-clcerts",
        "-legacy",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const x509Proc = Bun.spawn([opensslBin, "x509", "-enddate", "-noout"], {
      stdin: pkcs12Proc.stdout,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [pkcs12Code, x509Code, out] = await Promise.all([
      pkcs12Proc.exited,
      x509Proc.exited,
      new Response(x509Proc.stdout).text(),
    ]);
    if (pkcs12Code !== 0 || x509Code !== 0) return null;

    const match = /notAfter=(.+)/.exec(out);
    if (match === null) return null;
    return safeParseDate(match[1] ?? "");
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

if (import.meta.main) {
  const repo = process.env["GITHUB_REPOSITORY"];
  const token = process.env["GITHUB_TOKEN"];
  if (!repo || !token) {
    console.error("check-secret-health: GITHUB_REPOSITORY + GITHUB_TOKEN required");
    process.exit(2);
  }
  const rawThreshold = Number(process.env["THRESHOLD_DAYS"] ?? "21");
  const thresholdDays = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? rawThreshold : 21;
  const pats: readonly { env: string; token: string | undefined; strategy: PatStrategy }[] = [
    {
      env: "WINGET_PAT",
      token: process.env["WINGET_PAT"],
      strategy: { kind: "scopes", required: "public_repo" } as PatStrategy,
    },
    {
      env: "NIMBUS_CHECKS_TOKEN",
      token: process.env["NIMBUS_CHECKS_TOKEN"],
      strategy: { kind: "alive" } as PatStrategy,
    },
    {
      env: "SCORECARD_TOKEN",
      token: process.env["SCORECARD_TOKEN"],
      strategy: { kind: "alive" } as PatStrategy,
    },
  ];
  const certs = [
    {
      name: "GPG_SIGNING_SUBKEY",
      secretEnv: "GPG_SIGNING_SUBKEY",
      passwordEnv: "GPG_PASSPHRASE",
      present: Boolean(process.env["GPG_SIGNING_SUBKEY"]),
      decode: decodeGpgExpiry,
    },
    {
      name: "WINDOWS_CERT_PFX_BASE64",
      secretEnv: "WINDOWS_CERT_PFX_BASE64",
      passwordEnv: "WINDOWS_CERT_PASSWORD",
      present: Boolean(process.env["WINDOWS_CERT_PFX_BASE64"]),
      decode: decodePkcs12Expiry,
    },
    {
      name: "APPLE_CERT_P12_BASE64",
      secretEnv: "APPLE_CERT_P12_BASE64",
      passwordEnv: "APPLE_CERT_PASSWORD",
      present: Boolean(process.env["APPLE_CERT_P12_BASE64"]),
      decode: decodePkcs12Expiry,
    },
  ];
  const appMintRow: HealthRow = {
    name: "RELEASE_BOT_APP",
    kind: "pat",
    status: classifyAppMint(process.env["APP_MINT_STATUS"] ?? ""),
    detail: "scoped mint: Nimbus+homebrew-tap+scoop-bucket+linux-repo",
  };
  const provenanceRows: HealthRow[] = [
    {
      name: "@nimbus-dev/sdk",
      kind: "provenance",
      status: classifyProvenanceOutcome(process.env["SDK_PROVENANCE_STATUS"] ?? ""),
      detail: composeProvenanceDetail(
        process.env["SDK_VERSION"] ?? "",
        process.env["SDK_PROVENANCE_DETAIL"] ?? "",
      ),
    },
    {
      name: "@nimbus-dev/client",
      kind: "provenance",
      status: classifyProvenanceOutcome(process.env["CLIENT_PROVENANCE_STATUS"] ?? ""),
      detail: composeProvenanceDetail(
        process.env["CLIENT_VERSION"] ?? "",
        process.env["CLIENT_PROVENANCE_DETAIL"] ?? "",
      ),
    },
  ];
  // The auditor token is minted by the workflow and passed in; without it the
  // inventory check is skipped rather than reported as "no secrets found",
  // which would fire `missing` for every declared credential at once.
  const auditorToken = process.env["AUDITOR_TOKEN"] ?? "";
  const inventoryRows: HealthRow[] = [];
  if (auditorToken) {
    // No repo list is passed: enumerateSecrets discovers every repo the auditor
    // App can see. Deriving it from the manifest would only look where the
    // manifest already points, which is precisely where an undocumented secret
    // is NOT.
    const { secrets, errors } = await enumerateSecrets({ token: auditorToken });
    for (const e of errors) {
      inventoryRows.push({
        name: "inventory",
        kind: "inventory",
        status: "undocumented",
        detail: `enumeration failed: ${e} — inventory is incomplete, treat as unverified`,
      });
    }
    inventoryRows.push(...auditCredentials(CREDENTIAL_REGISTRY, secrets, new Date()));
  } else {
    inventoryRows.push({
      name: "inventory",
      kind: "inventory",
      status: "audit-overdue",
      detail: "AUDITOR_TOKEN not provided — credential inventory not checked this run",
    });
  }
  const { hardFailure } = await runSecretHealth({
    api: createGitHubApi({ token, repo }),
    now: new Date(),
    thresholdDays,
    pats,
    certs,
    extraRows: [appMintRow, ...provenanceRows, ...inventoryRows],
  });
  // process.exit() after awaited I/O can truncate buffered stdout before it
  // flushes — a recurring defect class in this project (it previously caused
  // exit 127 on SUCCESS in a sibling task) — and the `console.log(s.table)`
  // inside runSecretHealth just above is exactly that exposure, made larger by
  // this branch's extra provenance/absence rows. process.exitCode lets the
  // event loop drain naturally instead.
  process.exitCode = hardFailure ? 1 : 0;
}
