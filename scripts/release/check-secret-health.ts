import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export interface HealthRow {
  readonly name: string;
  readonly kind: "pat" | "cert";
  readonly status: PatStatus | CertStatus;
  readonly detail: string;
}

export function summarize(rows: readonly HealthRow[]): {
  hasHardFailure: boolean;
  hasWarning: boolean;
  table: string;
  state: string;
} {
  const hard = new Set<string>(["dead", "insufficient", "expired"]);
  const warn = new Set<string>(["expiring", "indeterminate"]);
  const hasHardFailure = rows.some((r) => hard.has(r.status));
  const hasWarning = rows.some((r) => warn.has(r.status));
  const table = [
    "| Credential | Kind | Status | Detail |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.kind} | ${r.status} | ${r.detail} |`),
  ].join("\n");
  const state = rows
    .map((r) => `${r.name}=${r.status}`)
    .sort()
    .join(";");
  return { hasHardFailure, hasWarning, table, state };
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
}): Promise<{ hardFailure: boolean }> {
  const rows: HealthRow[] = [];
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
        detail: p.strategy.kind,
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
  const caveat =
    "\n\n> Note: PATs are checked dead/alive + authorization only — fine-grained PAT *expiry dates* are not exposed by the API, so a dead PAT is caught within one weekly cycle, not ahead. Certs get true N-days-ahead warning.";
  if (s.hasHardFailure || s.hasWarning) {
    await openOrUpdateHealthIssue(deps.api, {
      key: "secret-health",
      title: "🔑 Release secret-health alert",
      body: s.table + caveat,
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
  if (summaryPath) await Bun.write(summaryPath, `## Secret health\n\n${s.table}${caveat}\n`);
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
      env: "RELEASE_PAT",
      token: process.env["RELEASE_PAT"],
      strategy: { kind: "repo-write", targetRepos: [repo] } as PatStrategy,
    },
    {
      env: "RELEASE_PLEASE_PAT",
      token: process.env["RELEASE_PLEASE_PAT"],
      strategy: { kind: "repo-write", targetRepos: [repo] } as PatStrategy,
    },
    {
      env: "PACKAGE_MANAGER_PAT",
      token: process.env["PACKAGE_MANAGER_PAT"],
      strategy: {
        kind: "repo-write",
        targetRepos: ["nimbus-agent/homebrew-tap", "nimbus-agent/scoop-bucket"],
      } as PatStrategy,
    },
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
  const { hardFailure } = await runSecretHealth({
    api: createGitHubApi({ token, repo }),
    now: new Date(),
    thresholdDays,
    pats,
    certs,
  });
  process.exit(hardFailure ? 1 : 0);
}
