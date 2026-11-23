import type { OwnershipInput } from "../../agents/_lib/ownership-types.ts";
import { MAX_SINCE_MS as MAX_NEGOTIATE_SINCE_MS } from "../../agents/negotiate.ts";
import type { ClientKind } from "../server/client-kind.ts";
import { AgentsRpcError } from "./_shared.ts";
import { MAX_FILE_LEN, MAX_SERVICE_LEN, MAX_SINCE_MS, MIN_FILE_LEN } from "./limits.ts";
import {
  optionalBoundedString,
  optionalSinceMs,
  requireObjectPayload,
  requireUrlArm,
} from "./params-common.ts";

/**
 * `agents.standup` takes only a window. There is deliberately no `--person`/`personId` parameter:
 * the brief is scoped to the LOCAL OWNER, resolved from local state, and a caller-supplied person
 * would turn a personal standup into `negotiate --person` — the dossier-builder shape that keeps
 * `agents.negotiate` off every external surface and out of the fleet. `[user] mePersonId` is the
 * one way to change who this is about, and it is owner-written config rather than a request field.
 */
export function requireStandupParams(params: unknown): { sinceMs?: number } {
  requireObjectPayload(params, "agents.standup");
  const p = params as { sinceMs?: unknown };
  const out: { sinceMs?: number } = {};
  const sinceMs = optionalSinceMs(p.sinceMs, MAX_SINCE_MS, "90 days");
  if (sinceMs !== undefined) out.sinceMs = sinceMs;
  return out;
}

/**
 * Which caller kinds may use `agents.oncall`'s OWNER-SCOPED zero-parameter shape.
 *
 * TOTAL over `ClientKind` on purpose, for the reason `EGRESS_BEARING_CLIENT_KINDS` is: written as
 * a `Partial` or a `Map`, a future transport would be an `undefined` lookup and would silently
 * take whichever branch the `??` picked. As a total `Record`, adding a member to `ClientKind`
 * without deciding its answer does not compile.
 *
 * **This is deliberately NOT `EGRESS_BEARING_CLIENT_KINDS` reused.** That map answers "do this
 * kind's briefs leave the machine", and it maps `chatops` to `null` because a ChatOps post is
 * ledgered at the post rather than at the brief. Here `chatops` must be FALSE: a ChatOps caller is
 * a person in a shared room, and handing them the gateway owner's active incident is precisely the
 * leak this table exists to prevent. Two questions that agree on six of seven members and differ
 * on the one that matters are two tables, not one.
 *
 * **Why `unknown` is TRUE, which looks like a hole and is not.** `session.declareKind` is called by
 * two clients in this repo — the MCP adapter (`packages/cli/src/mcp/adapter.ts`, `mcp`) and the
 * desktop's Tauri bridge (`packages/ui/src-tauri/src/gateway_bridge.rs`, `ui`, which maps like
 * `unknown` here). The plain CLI declares nothing, so `nimbus oncall` from the owner's terminal arrives as `unknown`; making
 * that false would refuse the command's primary use. What `unknown` actually means is "reached the
 * gateway over the local socket without declaring", and the socket's access control is the
 * filesystem — the same boundary the CLI already relies on for every other method. The three kinds
 * that must be refused are all DERIVED and can never be declared: `http` is set by the route
 * handler after checking a bearer token, `chatops` by the ChatOps subsystem, `fleet` by the
 * scheduler. So an external caller cannot reach `unknown` by staying quiet — it would have to be
 * on the socket already, which is the owner's machine.
 *
 * `mcp` is false even though it is also on that socket: an MCP client is a model with a tool loop,
 * and `standup`'s exclusion reasoning applies unchanged — a caller that cannot establish who it is
 * would receive the OWNER's incident. The shipped adapter disables its agent tools outright when
 * `declareKind` is unsupported, so it cannot reach this by declining to declare.
 *
 * `fleet` is true: a fleet run is the gateway's own scheduler on the owner's machine, executing a
 * job the owner wrote into their own config. In practice a fleet job names its service, so it
 * takes the explicit shape anyway and never reaches this.
 */
const OWNER_SCOPED_ONCALL_ALLOWED: Readonly<Record<ClientKind, boolean>> = Object.freeze({
  cli: true,
  ui: true,
  unknown: true,
  fleet: true,
  // false, not true: the push runner ALWAYS names `incidentId`, so this entry is never consulted on
  // the happy path — it exists so a push call that ever lost its incidentId is REFUSED rather than
  // quietly briefing whatever the owner-scoped resolution picks.
  push: false,
  mcp: false,
  http: false,
  chatops: false,
});

/**
 * Whether this caller may ask "which incident is mine" rather than naming one.
 *
 * `undefined` — no caller descriptor at all — is ALLOWED, and that is coherent rather than a
 * fail-open gap: the socket dispatcher sets `caller` unconditionally
 * (`ipc/server/dispatchers.ts`), so `undefined` is reachable only from an in-process caller or a
 * unit test, which is strictly more local than the socket. Every kind that must be refused is
 * derived by the gateway and therefore always present. Refusing `undefined` while allowing
 * `unknown` would be the incoherent choice — both mean "no kind was declared" — and would buy
 * nothing an attacker could not sidestep by connecting to the socket.
 */
export function mayUseOwnerScopedOncall(caller: { kind: ClientKind } | undefined): boolean {
  return caller === undefined ? true : OWNER_SCOPED_ONCALL_ALLOWED[caller.kind];
}

const MAX_INCIDENT_ID_LEN = 512;

/**
 * `agents.oncall` takes an OPTIONAL incident id, an OPTIONAL service, and an optional chat window.
 *
 * Three shapes, in a fixed precedence: `incidentId` names the incident outright, `service` narrows
 * to one service's PagerDuty ids, and supplying neither resolves the LOCAL OWNER's identity and
 * asks which incidents are assigned to them.
 *
 * **The third shape is refused for an external caller, and that refusal is invariant `I36`'s
 * shape.** `agents.oncall` is externally permitted as a method, but its zero-parameter form
 * resolves `[user] mePersonId` / `git config user.email` / the OS username — so over HTTP, MCP or
 * ChatOps it is meaningless in one direction and leaky in the other: a bearer token cannot ask
 * about itself, and would receive the OWNER's active incident, assignees included. That is exactly
 * the concern that keeps `agents.standup` off every external surface entirely. The difference here
 * is that `oncall` HAS an answerable external shape — name the service — so the bound goes on the
 * SHAPE rather than on the method, the same way `requireFileParam` refuses federation alongside a
 * forge coordinate rather than refusing `agents.ghost`.
 *
 * **Refused, never silently narrowed.** Answering an external zero-parameter call by returning
 * nothing would tell a caller who asked "what is on fire" that the answer is "nothing" — which on
 * this command is the one wrong answer that reads like a good one.
 *
 * `incidentId` and `service` are mutually exclusive, mirroring `ownership`'s `path` vs `service`:
 * an explicit incident already determines its service, so accepting both invites a caller to pass
 * a contradictory pair and get the incident's own service silently.
 */
export function requireOncallParams(
  params: unknown,
  caller: { kind: ClientKind } | undefined,
): { incidentId?: string; service?: string; sinceMs?: number } {
  requireObjectPayload(params, "agents.oncall");
  const p = params as { incidentId?: unknown; service?: unknown; sinceMs?: unknown };
  const out: { incidentId?: string; service?: string; sinceMs?: number } = {};

  const incidentId = optionalBoundedString(
    p.incidentId,
    "incidentId",
    MAX_INCIDENT_ID_LEN,
    "characters",
  );
  if (incidentId !== undefined) out.incidentId = incidentId;

  const service = optionalBoundedString(p.service, "service", MAX_SERVICE_LEN, "characters");
  if (service !== undefined) out.service = service;

  if (out.incidentId !== undefined && out.service !== undefined) {
    throw new AgentsRpcError(
      -32602,
      "agents.oncall accepts incidentId or service, not both — an explicit incident already " +
        "determines its service",
    );
  }

  const sinceMs = optionalSinceMs(p.sinceMs, MAX_SINCE_MS, "90 days");
  if (sinceMs !== undefined) out.sinceMs = sinceMs;

  if (
    out.incidentId === undefined &&
    out.service === undefined &&
    !mayUseOwnerScopedOncall(caller)
  ) {
    throw new AgentsRpcError(
      -32602,
      "agents.oncall requires incidentId or service on this surface: without one it reports the " +
        "incidents assigned to the gateway owner, which is not what a remote caller is asking for.",
    );
  }

  return out;
}

export function requireJanitorParams(params: unknown): {
  resourceRef: string;
  idleDays: number;
  cleanupAction: string | null;
  allowGaps: boolean;
} {
  if (params === null || typeof params !== "object") {
    throw new AgentsRpcError(-32602, "agents.janitor: object params required");
  }
  const p = params as Record<string, unknown>;
  const resourceRef = typeof p["resourceRef"] === "string" ? p["resourceRef"].trim() : "";
  if (resourceRef.length === 0) {
    throw new AgentsRpcError(-32602, "agents.janitor: resourceRef (non-empty string) required");
  }
  const idleDaysRaw = p["idleDays"];
  return {
    resourceRef,
    idleDays:
      typeof idleDaysRaw === "number" && Number.isInteger(idleDaysRaw) && idleDaysRaw > 0
        ? idleDaysRaw
        : 14,
    cleanupAction:
      typeof p["cleanupAction"] === "string" && p["cleanupAction"].length > 0
        ? p["cleanupAction"]
        : null,
    allowGaps: p["allowGaps"] === true,
  };
}

export function requirePreflightParams(params: unknown): {
  ref: string;
  namespace: string;
  changedSurface: string[];
} {
  if (params === null || typeof params !== "object") {
    throw new AgentsRpcError(-32602, "agents.preflight: object params required");
  }
  const p = params as Record<string, unknown>;
  const ref = typeof p["ref"] === "string" ? p["ref"].trim() : "";
  if (ref.length === 0) {
    throw new AgentsRpcError(-32602, "agents.preflight: ref (non-empty string) required");
  }
  const namespace = typeof p["namespace"] === "string" ? p["namespace"].trim() : "";
  if (namespace.length === 0) {
    throw new AgentsRpcError(-32602, "agents.preflight: namespace (non-empty string) required");
  }
  const surface = Array.isArray(p["changedSurface"])
    ? p["changedSurface"].filter((s): s is string => typeof s === "string")
    : [];
  return { ref, namespace, changedSurface: surface };
}

const MAX_PERSON_ID_LEN = 256;

/**
 * `agents.negotiate`'s OWN `sinceMs` bound — deliberately NOT the shared `MAX_SINCE_MS` (90
 * days) every sibling validator uses. `MAX_SINCE_MS` is sized for `catchup`'s "what happened
 * while I was away" use case; negotiate's headline use is preparing for a review cycle, and an
 * annual review needs a year of evidence. Clamping negotiate to a quarter would make the agent
 * unable to answer the question it exists for — see `agents/negotiate.ts`'s own
 * `MAX_SINCE_MS = 365 days`, which this IMPORTS (aliased) rather than restates. A second copy of
 * the literal was the shape to avoid: the two files diverging fails SILENTLY — the IPC would
 * accept a window `runNegotiate` then clamps with `Math.min`, printing a smaller window than the
 * caller asked for, which is the exact silent-clamping behaviour the explicit rejection below
 * exists to replace. This is a per-method bound, not a broader raise: every other `require*Params`
 * validator in this file stays on the shared 90-day constant.
 */
export function requireNegotiateParams(params: unknown): { sinceMs?: number; personId?: string } {
  requireObjectPayload(params, "agents.negotiate");
  const p = params as { sinceMs?: unknown; personId?: unknown };
  const out: { sinceMs?: number; personId?: string } = {};
  const sinceMs = optionalSinceMs(p.sinceMs, MAX_NEGOTIATE_SINCE_MS, "365 days");
  if (sinceMs !== undefined) out.sinceMs = sinceMs;
  const personId = optionalBoundedString(p.personId, "personId", MAX_PERSON_ID_LEN);
  if (personId !== undefined) out.personId = personId;
  return out;
}

export function requireOwnershipParams(params: unknown): OwnershipInput {
  if (params === null || params === undefined) return {};
  requireObjectPayload(params, "agents.ownership");
  const p = params as { path?: unknown; service?: unknown; itemUrl?: unknown };
  // A count, not a pairwise check: with three scopes the old `path && service` form would
  // have let `{ path, itemUrl }` through, and lane 1 would silently answer only one of them.
  const scopes = [p.path, p.service, p.itemUrl].filter((v) => v !== undefined).length;
  if (scopes > 1) {
    throw new AgentsRpcError(
      -32602,
      "path, service and itemUrl are mutually exclusive — pass one, or none for a coverage summary",
    );
  }
  const out: { path?: string; service?: string; itemUrl?: string } = {};
  if (p.itemUrl !== undefined) {
    // The same guards `why`'s URL arms get — this value comes off a browser address bar too.
    out.itemUrl = requireUrlArm(p.itemUrl, "itemUrl");
  }
  if (p.path !== undefined) {
    if (typeof p.path !== "string") {
      throw new AgentsRpcError(-32602, "path must be a string");
    }
    const trimmed = p.path.trim();
    if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
      throw new AgentsRpcError(-32602, `path must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
    }
    out.path = trimmed;
  }
  const service = optionalBoundedString(p.service, "service", MAX_SERVICE_LEN);
  if (service !== undefined) out.service = service;
  return out;
}
