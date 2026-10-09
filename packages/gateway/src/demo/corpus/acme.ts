import { createHash } from "node:crypto";

import type { TourStepKind } from "../../agents/_lib/tour-types.ts";
import { buildCiRunMetadata } from "../../connectors/ci-run-meta.ts";
import { PAGERDUTY_INCIDENT_META_VERSION } from "../../connectors/pagerduty-attribution.ts";
import { buildPrMetadata } from "../../connectors/pr-meta.ts";
import {
  DAY,
  type DemoCommit,
  type DemoCorpus,
  type DemoDeployment,
  type DemoFile,
  type DemoItem,
  type DemoPerson,
  type DemoService,
  HOUR,
  MINUTE,
} from "./types.ts";

/**
 * "Acme" — a fictional org seeded by `nimbus demo` (spec § 4.3). One connected storyline every
 * tour brief reaches from a different angle:
 *   ticket PAY-231 → PR #412 (Dana) changes src/retry/backoff.ts → merged → deployed to
 *   payment-service at T−11m (finished ~T−8m) → a P1 assigned to the demo persona (Sam) that
 *   `demo.firePage` fires at T (NOT seeded — see {@link PAGING_INCIDENT}) → chat naming the service
 *   follows the page → a same-service incident 3 weeks earlier → all blame on src/retry is Dana's
 *   (bus factor 1).
 * Everything else is background so standup / expert / stats / changelog / glossary / decisions
 * have real content. Nothing here is real: every domain is `.example`.
 */

/**
 * Deterministic 40-hex sha for a label (not a real commit). SHA-256 truncated to git's SHA-1
 * length: the value only has to look like a commit id, and a weak hash is avoided outright.
 */
function sha(label: string): string {
  return createHash("sha256").update(`acme-demo:${label}`).digest("hex").slice(0, 40);
}

const person = (key: string, first: string, last: string): DemoPerson => ({
  key,
  email: `${first.toLowerCase()}.${last.toLowerCase()}@acme.example`,
  displayName: `${first} ${last}`,
  githubLogin: `${first.toLowerCase()}-${last.toLowerCase()}`,
  slackHandle: first.toLowerCase(),
});

const PEOPLE: readonly DemoPerson[] = [
  person("sam", "Sam", "Rivera"), // the demo persona ("me")
  person("dana", "Dana", "Okafor"),
  person("lee", "Lee", "Chen"),
  person("priya", "Priya", "Nair"),
  person("marco", "Marco", "Bianchi"),
  person("yuki", "Yuki", "Tanaka"),
  person("omar", "Omar", "Haddad"),
  person("ines", "Ines", "Duarte"),
];

const SERVICES: readonly DemoService[] = [
  { id: "payment-service", repo: "acme/payments", pagerdutyServiceId: "PPAYDEMO" },
  { id: "checkout-web", repo: "acme/checkout-web", pagerdutyServiceId: "PCHKDEMO" },
  { id: "ledger-worker", repo: "acme/ledger", pagerdutyServiceId: "PLEDDEMO" },
];

/**
 * The PagerDuty id of the storyline's paging incident — {@link PAGING_INCIDENT}, written by
 * `fireDemoPage` at fire time rather than by the seed.
 */
const PAGING_INCIDENT_ID = "PDEMO412";

/**
 * The demo tour, as selector CANDIDATES — `seedDemoCorpus` turns each into a `TourStep` through
 * `tourStepFor(kind, candidate, true)`, the same constructor `nimbus wow`'s planner uses, so the
 * printed `command` and the executed `args` come from one value here.
 *
 * Unlike `nimbus wow`'s selectors these are FIXED: the demo corpus is deterministic, so the three
 * steps that tell its one storyline are chosen here rather than rediscovered from the index. The
 * order is the order the story reads in: the page, then the line that caused it, then who owns
 * that code. The titles are byte-identical to the headers the release gate
 * (`scripts/release/assert-demo-tour.ts`) greps for.
 *
 * `why` deliberately keeps a RELATIVE ref: `nimbus why` resolves it against the configured root,
 * and that relative form is what the docs and the release gate print.
 */
export const ACME_TOUR_STEPS = [
  {
    kind: "oncall",
    title: "On-call triage",
    // The brief the page that `demo.firePage` just fired PUSHED — the newest pushed brief, so no
    // incident id is needed here (`nimbus oncall --incident pagerduty:PDEMO412` still works after
    // the page, so it stays a valid command to suggest).
    args: ["pushed"],
    reason: "the page that just fired",
  },
  {
    kind: "why",
    title: "Why this line changed",
    args: ["src/retry/backoff.ts:42"],
    reason: "the capped-backoff line",
  },
  {
    kind: "owners",
    title: "Who owns this code",
    args: ["src/retry"],
    reason: "bus factor 1",
  },
] as const satisfies readonly {
  kind: TourStepKind;
  title: string;
  args: readonly string[];
  reason: string;
}[];

const SHA_RETRY_BASE = sha("retry-base");
const SHA_412 = sha("pr-412");

const BACKOFF_LINES: readonly string[] = [
  '// Synthetic demo file: part of the fictional "Acme" org seeded by `nimbus demo`.',
  "// Retry backoff for card-authorization calls to the payment service provider (PSP).",
  "//",
  "// Nothing here is real code from any real company.",
  "",
  "export const BASE_BACKOFF_MS = 250;",
  "export const MAX_BACKOFF_MS = 8_000;",
  "export const MAX_ATTEMPTS = 6;",
  "",
  "export type RetryDecision =",
  "  | { readonly retry: true; readonly delayMs: number }",
  "  | { readonly retry: false; readonly reason: string };",
  "",
  "/**",
  " * Whether a failed PSP call is worth retrying at all. Card declines are final;",
  " * timeouts and 5xx responses are not.",
  " */",
  'export function isRetryable(status: number | "timeout"): boolean {',
  '  if (status === "timeout") return true;',
  "  return status >= 500 && status !== 501;",
  "}",
  "",
  "/**",
  " * Exponential backoff with a hard ceiling.",
  " *",
  " * History: before PAY-231 the ceiling was 60s, and a PSP brown-out turned",
  " * every in-flight charge into a minute-long retry loop. PR #412 lowered the",
  " * ceiling to 8s so a brown-out surfaces as errors instead of a stuck queue.",
  " */",
  "export function nextBackoff(",
  "  attempt: number,",
  '  status: number | "timeout",',
  "): RetryDecision {",
  "  if (!isRetryable(status)) {",
  '    return { retry: false, reason: "status " + String(status) + " is final" };',
  "  }",
  "  if (attempt >= MAX_ATTEMPTS) {",
  '    return { retry: false, reason: "attempts exhausted" };',
  "  }",
  "  const base = BASE_BACKOFF_MS;",
  "  // Capped: see the history note above.",
  "  const delayMs = Math.min(base * 2 ** attempt, MAX_BACKOFF_MS);",
  "  return { retry: true, delayMs };",
  "}",
];
/** Line 42 (1-based) is the capped `delayMs` — the line the tour asks `why` about. */
const BACKOFF_412_LINES = new Set([7, 26, 27, 28, 42]);

const JITTER_LINES: readonly string[] = [
  '// Synthetic demo file: part of the fictional "Acme" org seeded by `nimbus demo`.',
  "",
  "/** Full jitter: a uniformly random delay in [0, capMs). */",
  "export function withJitter(capMs: number, random: () => number = Math.random): number {",
  "  return Math.floor(random() * capMs);",
  "}",
];

const HANDLER_LINES: readonly string[] = [
  '// Synthetic demo file: part of the fictional "Acme" org seeded by `nimbus demo`.',
  "",
  'import { nextBackoff } from "../retry/backoff.ts";',
  "",
  "export async function authorizeCharge(attempt: number, call: () => Promise<number>) {",
  "  const status = await call();",
  "  if (status < 300) return { ok: true as const };",
  "  const decision = nextBackoff(attempt, status);",
  "  return decision.retry ? { ok: false as const, retryInMs: decision.delayMs } : { ok: false as const };",
  "}",
];

const SHA_HANDLER_PRIYA = sha("handler-priya");
const SHA_HANDLER_MARCO = sha("handler-marco");
const SHA_HANDLER_LEE = sha("handler-lee");

/** The commit that last touched handler line `i` (0-based): three authors in contiguous bands. */
function handlerBlameFor(i: number): string {
  if (i < 4) return SHA_HANDLER_PRIYA;
  if (i < 7) return SHA_HANDLER_MARCO;
  return SHA_HANDLER_LEE;
}

const FILES: readonly DemoFile[] = [
  {
    path: "src/retry/backoff.ts",
    lines: BACKOFF_LINES,
    blame: BACKOFF_LINES.map((_, i) => (BACKOFF_412_LINES.has(i + 1) ? SHA_412 : SHA_RETRY_BASE)),
  },
  {
    path: "src/retry/jitter.ts",
    lines: JITTER_LINES,
    blame: JITTER_LINES.map(() => SHA_RETRY_BASE),
  },
  {
    path: "src/charges/handler.ts",
    lines: HANDLER_LINES,
    blame: HANDLER_LINES.map((_, i) => handlerBlameFor(i)),
  },
];

const COMMITS: readonly DemoCommit[] = [
  {
    sha: SHA_RETRY_BASE,
    authorKey: "dana",
    subject: "Add exponential backoff for PSP calls",
    offsetMs: -60 * DAY,
  },
  {
    sha: SHA_412,
    authorKey: "dana",
    subject: "Cap PSP retry backoff at 8s (PAY-231)",
    offsetMs: -3 * HOUR,
  },
  {
    sha: SHA_HANDLER_PRIYA,
    authorKey: "priya",
    subject: "Add charge authorization handler",
    offsetMs: -40 * DAY,
  },
  {
    sha: SHA_HANDLER_MARCO,
    authorKey: "marco",
    subject: "Retry card authorization on 5xx",
    offsetMs: -20 * DAY,
  },
  {
    sha: SHA_HANDLER_LEE,
    authorKey: "lee",
    subject: "Surface retry delay to the caller",
    offsetMs: -10 * DAY,
  },
];

const PR_URL = (repo: string, n: number): string =>
  `https://github.example/${repo}/pull/${String(n)}`;

// ---------------------------------------------------------------------------------------------
// The storyline
// ---------------------------------------------------------------------------------------------

const STORY_ISSUES: readonly DemoItem[] = [
  {
    service: "linear",
    type: "issue",
    externalId: "PAY-231",
    title: "PAY-231: retry storms on card-authorization timeouts",
    body: "During the last PSP brown-out every in-flight charge retried for up to 60s. Cap the backoff.",
    offsetMs: -9 * DAY,
    authorKey: "priya",
    metadata: (at) => ({ key: "PAY-231", state: "done", created_at_ms: at(-9 * DAY) }),
  },
];

const STORY_PRS: readonly DemoItem[] = [
  {
    service: "github",
    type: "pr",
    externalId: "acme/payments#412",
    title: "Cap PSP retry backoff at 8s (PAY-231)",
    body: "Fixes PAY-231. Lowers MAX_BACKOFF_MS from 60s to 8s so a PSP brown-out surfaces as errors instead of a stuck queue.",
    offsetMs: -3 * HOUR,
    authorKey: "dana",
    url: PR_URL("acme/payments", 412),
    metadata: (at) =>
      buildPrMetadata(
        {
          draft: false,
          merge_commit_sha: SHA_412,
          additions: 18,
          deletions: 6,
          changed_files: 2,
          labels: [],
        },
        {
          state: "merged",
          stateRaw: "closed",
          openedAtMs: at(-3 * HOUR - DAY),
          mergedAtMs: at(-3 * HOUR),
          repo: "acme/payments",
          number: 412,
        },
      ),
  },
];

const STORY_REVIEWS: readonly DemoItem[] = [
  {
    service: "github",
    type: "review",
    externalId: "acme/payments#412/review-1",
    title: "Review: Cap PSP retry backoff at 8s (PAY-231)",
    body: "Approved. 8s matches the PSP's own client timeout.",
    offsetMs: -(3 * HOUR + 30 * MINUTE),
    authorKey: "lee",
    metadata: () => ({ repo: "acme/payments", pr_number: 412, state: "APPROVED" }),
  },
];

const STORY_DEPLOY: DemoDeployment = {
  serviceId: "payment-service",
  sha: SHA_412,
  // Finishes ~8 min before the page that `demo.firePage` fires (the seed adds 3 min to finish a
  // deploy, and the seed → restart → fire gap is seconds).
  offsetMs: -11 * MINUTE,
  status: "success",
  runId: "7412",
};

const incident = (
  externalId: string,
  title: string,
  offsetMs: number,
  status: "triggered" | "resolved",
  assigneeKey: string,
  pagerdutyServiceId: string,
  resolvedByKey?: string,
): DemoItem => ({
  service: "pagerduty",
  type: "incident",
  externalId,
  title,
  body: status,
  offsetMs,
  metadata: (at) => ({
    incidentId: externalId,
    status,
    severity: "P1",
    urgency: "high",
    opened_at_ms: at(offsetMs),
    pagerduty_service_id: pagerdutyServiceId,
    assignee_emails: [emailOf(assigneeKey)],
    ...(resolvedByKey === undefined ? {} : { resolved_by_email: emailOf(resolvedByKey) }),
    unattributed_actors: [],
    meta_v: PAGERDUTY_INCIDENT_META_VERSION,
  }),
});

function emailOf(key: string): string {
  const p = PEOPLE.find((x) => x.key === key);
  if (p === undefined) throw new Error(`acme corpus: unknown person ${key}`);
  return p.email;
}

/**
 * The storyline's paging incident. NOT part of the seeded corpus: `fireDemoPage` writes it with
 * `opened_at_ms = now` (offset 0 from the fire time), so it is newer than the push runtime's boot
 * `enabled_at` and the SAME selection a real PagerDuty sync drives picks it up.
 */
export const PAGING_INCIDENT: DemoItem = incident(
  PAGING_INCIDENT_ID,
  "payment-service: 5xx rate above 5% on /v1/charges",
  0,
  "triggered",
  "sam",
  "PPAYDEMO",
);

const STORY_INCIDENTS: readonly DemoItem[] = [
  incident(
    "PDEMO301",
    "payment-service: charge latency p99 above 4s",
    -21 * DAY,
    "resolved",
    "lee",
    "PPAYDEMO",
    "lee",
  ),
];

const message = (
  id: string,
  channel: string,
  authorKey: string,
  offsetMs: number,
  text: string,
): DemoItem => ({
  service: "slack",
  type: "message",
  externalId: `${channel}/${id}`,
  title: text.length > 80 ? `${text.slice(0, 77)}...` : text,
  body: text,
  offsetMs,
  authorKey,
  metadata: () => ({ channel }),
});

/**
 * The team's chatter after the page. NOT seeded: `fireDemoPage` writes these AFTER the push run
 * completed, anchored at the moment they are written (offsets are ms after that moment), so the
 * pushed brief is honestly assembled before anyone typed. They stay in the index for any later
 * `nimbus oncall --incident`.
 */
export const PAGE_FOLLOW_UPS: readonly DemoItem[] = [
  message(
    "m1",
    "payments-incidents",
    "sam",
    0,
    "Paged: payment-service 5xx above 5% on /v1/charges. Looking now.",
  ),
  message(
    "m2",
    "payments-incidents",
    "dana",
    1,
    "PR #412 (PAY-231) went out to payment-service about eight minutes before the alert. Checking whether the 8s cap is involved.",
  ),
  message(
    "m3",
    "payments-incidents",
    "lee",
    2,
    "payment-service errors are all PSP timeouts. Same shape as the incident three weeks ago.",
  ),
];

// ---------------------------------------------------------------------------------------------
// Background (deterministic)
// ---------------------------------------------------------------------------------------------

const BACKGROUND_TITLES: readonly string[] = [
  "Add idempotency key to refund endpoint",
  "Tighten PSP timeout budget for tokenization",
  "Batch ledger writes per settlement window",
  "Remove the legacy 3DS fallback path",
  "Emit charge latency histogram per PSP",
  "Make the checkout retry banner dismissible",
  "Cache FX rates for five minutes",
  "Split refund reconciliation into its own job",
  "Reject duplicate webhook deliveries",
  "Move ledger-worker to at-least-once delivery",
  "Guard against negative settlement amounts",
  "Log PSP decline codes without card data",
];
const AUTHOR_ROTATION: readonly string[] = [
  "dana",
  "lee",
  "priya",
  "marco",
  "yuki",
  "omar",
  "ines",
  "sam",
];

function background(): {
  prs: DemoItem[];
  reviews: DemoItem[];
  ciRuns: DemoItem[];
  deployments: DemoDeployment[];
  incidents: DemoItem[];
} {
  const prs: DemoItem[] = [];
  const reviews: DemoItem[] = [];
  const ciRuns: DemoItem[] = [];
  const deployments: DemoDeployment[] = [];
  const incidents: DemoItem[] = [];
  let n = 300;
  for (const [si, svc] of SERVICES.entries()) {
    for (let k = 0; k < 12; k++) {
      n += 1;
      const offsetMs = -(k * 5 + si + 1) * DAY;
      const authorKey = AUTHOR_ROTATION[(k + si) % AUTHOR_ROTATION.length] ?? "dana";
      const reviewerKey = AUTHOR_ROTATION[(k + si + 3) % AUTHOR_ROTATION.length] ?? "lee";
      const title = BACKGROUND_TITLES[(k + si * 4) % BACKGROUND_TITLES.length] ?? "Maintenance";
      const mergeSha = sha(`${svc.repo}#${String(n)}`);
      const runId = String(8000 + n);
      prs.push({
        service: "github",
        type: "pr",
        externalId: `${svc.repo}#${String(n)}`,
        title,
        body: `${title}. Part of routine ${svc.id} maintenance.`,
        offsetMs,
        authorKey,
        url: PR_URL(svc.repo, n),
        metadata: (at) =>
          buildPrMetadata(
            {
              draft: false,
              merge_commit_sha: mergeSha,
              additions: 20 + k * 3,
              deletions: 4 + k,
              changed_files: 1 + (k % 4),
              labels: [],
            },
            {
              state: "merged",
              stateRaw: "closed",
              openedAtMs: at(offsetMs - DAY),
              mergedAtMs: at(offsetMs),
              repo: svc.repo,
              number: n,
            },
          ),
      });
      reviews.push({
        service: "github",
        type: "review",
        externalId: `${svc.repo}#${String(n)}/review-1`,
        title: `Review: ${title}`,
        body: "Looks good.",
        offsetMs: offsetMs - HOUR,
        authorKey: reviewerKey,
        metadata: () => ({ repo: svc.repo, pr_number: n, state: "APPROVED" }),
      });
      const failed = svc.id === "payment-service" && k === 2;
      ciRuns.push({
        service: "github_actions",
        type: "ci_run",
        externalId: `${svc.repo}:run-${runId}`,
        title: "Deploy production",
        body: failed ? "failure" : "success",
        offsetMs: offsetMs + 2 * HOUR,
        metadata: () =>
          buildCiRunMetadata(
            {
              workflowName: "Deploy production",
              runId,
              event: "push",
              headSha: mergeSha,
              headBranch: "main",
              status: "completed",
            },
            {
              conclusion: failed ? "failure" : "success",
              conclusionRaw: failed ? "failure" : "success",
              branch: "main",
              repo: svc.repo,
              workflowName: "Deploy production",
              headSha: mergeSha,
            },
          ),
      });
      deployments.push({
        serviceId: svc.id,
        sha: mergeSha,
        offsetMs: offsetMs + 2 * HOUR,
        status: failed ? "failure" : "success",
        runId,
      });
      if (failed) {
        incidents.push(
          incident(
            `PDEMO${String(n)}`,
            `${svc.id}: settlement job failing after deploy`,
            offsetMs + 2 * HOUR + 20 * MINUTE,
            "resolved",
            "omar",
            svc.pagerdutyServiceId,
            "omar",
          ),
        );
      }
    }
  }
  return { prs, reviews, ciRuns, deployments, incidents };
}

/** "Me" in the last 24h: an open PR, a review, a ticket and chat — standup's lanes. */
const SAM_TODAY_PRS: readonly DemoItem[] = [
  {
    service: "github",
    type: "pr",
    externalId: "acme/payments#415",
    title: "Add a circuit breaker around PSP authorization",
    body: "Follow-up to PAY-231: stop calling the PSP for 30s after five consecutive timeouts.",
    offsetMs: -5 * HOUR,
    authorKey: "sam",
    url: PR_URL("acme/payments", 415),
    metadata: (at) =>
      buildPrMetadata(
        { draft: false, labels: [] },
        {
          state: "open",
          stateRaw: "open",
          openedAtMs: at(-5 * HOUR),
          repo: "acme/payments",
          number: 415,
        },
      ),
  },
];
const SAM_TODAY_REVIEWS: readonly DemoItem[] = [
  {
    service: "github",
    type: "review",
    externalId: "acme/checkout-web#314/review-2",
    title: "Review: Make the checkout retry banner dismissible",
    body: "Approved with one nit on the copy.",
    offsetMs: -6 * HOUR,
    authorKey: "sam",
    metadata: () => ({ repo: "acme/checkout-web", pr_number: 314, state: "APPROVED" }),
  },
];
const SAM_TODAY_ISSUES: readonly DemoItem[] = [
  {
    service: "linear",
    type: "issue",
    externalId: "PAY-240",
    title: "PAY-240: alert on PSP timeout rate, not only on 5xx",
    body: "Today's page fired on 5xx; the PSP timeout rate moved ten minutes earlier.",
    offsetMs: -2 * HOUR,
    authorKey: "sam",
    metadata: (at) => ({ key: "PAY-240", state: "todo", created_at_ms: at(-2 * HOUR) }),
  },
];

/** Glossary (a term needs >= 3 source docs) and decisions (snippet extraction reads "decided"). */
const KNOWLEDGE_MESSAGES: readonly DemoItem[] = [
  message(
    "k1",
    "payments-eng",
    "priya",
    -12 * DAY,
    "Reminder: the PSP (payment service provider) timeout budget is 8s end to end.",
  ),
  message(
    "k2",
    "payments-eng",
    "dana",
    -11 * DAY,
    "The PSP brown-out last month is why PAY-231 exists.",
  ),
  message(
    "k3",
    "payments-eng",
    "lee",
    -10 * DAY,
    "Every PSP call needs an idempotency key, including retries.",
  ),
  message(
    "k4",
    "ledger",
    "omar",
    -9 * DAY,
    "An idempotency key on the ledger write lets us retry settlement safely.",
  ),
  message(
    "k5",
    "checkout",
    "ines",
    -8 * DAY,
    "Checkout now sends the idempotency key it received from the cart service.",
  ),
  message(
    "k6",
    "payments-eng",
    "dana",
    -7 * DAY,
    "We decided to keep the 8s retry ceiling and add a circuit breaker instead of raising it.",
  ),
  message(
    "k7",
    "ledger",
    "omar",
    -6 * DAY,
    "We decided to move ledger-worker to at-least-once delivery and dedupe on the idempotency key.",
  ),
];

export function buildAcmeCorpus(): DemoCorpus {
  const bg = background();
  return {
    people: PEOPLE,
    meKey: "sam",
    services: SERVICES,
    commits: COMMITS,
    files: FILES,
    issues: [...STORY_ISSUES, ...SAM_TODAY_ISSUES],
    pullRequests: [...bg.prs, ...STORY_PRS, ...SAM_TODAY_PRS],
    reviews: [...bg.reviews, ...STORY_REVIEWS, ...SAM_TODAY_REVIEWS],
    ciRuns: bg.ciRuns,
    deployments: [...bg.deployments, STORY_DEPLOY],
    incidents: [...bg.incidents, ...STORY_INCIDENTS],
    messages: KNOWLEDGE_MESSAGES,
    pagerdutyLastSyncOffsetMs: -2 * MINUTE,
  };
}
