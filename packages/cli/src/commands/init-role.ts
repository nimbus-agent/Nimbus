// `nimbus init`'s "What do you do?" step (role packs P5). It runs once the gateway is up, after the
// repository step, and reads everything it offers from the gateway: the choices from `pack.list`
// (one per pack, matched on the pack's `roles` tags, never on a pack id), the connectors from
// `catalog.list`'s `suggestedConnectors`, and their state from `connector.listStatus`. Installing a
// pack goes through the existing `nimbus pack install` path, so its approval is the one the owner
// already knows.

import { stripControlChars } from "../lib/strip-control-chars.ts";

export type RoleAnswer =
  | {
      readonly kind: "pack";
      readonly packId: string;
      readonly name: string;
      readonly installed: boolean;
    }
  | { readonly kind: "engineering" }
  | { readonly kind: "design" }
  | { readonly kind: "other" };

export interface RoleChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export type SignInKind = "browser" | "atlassian" | "terminal";

export interface ConnectorSuggestion {
  readonly id: string;
  readonly displayName: string;
  readonly signIn: SignInKind;
  readonly connected: boolean;
}

export type UnknownRole = { readonly kind: "unknown-role"; readonly message: string };

export class RoleFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleFlagError";
  }
}

const ROLE_VALUE_RE = /^(?:pack:)?[a-z][a-z0-9_-]{0,31}$/;
const FIXED_ROLES = ["engineering", "design", "other"] as const;
type FixedRole = (typeof FIXED_ROLES)[number];
const FIXED_LABEL: Readonly<Record<FixedRole, string>> = {
  engineering: "Engineering",
  design: "Design",
  other: "Something else",
};

/** `--role <value>`: undefined when absent; a missing or malformed value is a usage error. */
export function parseRoleFlag(args: readonly string[]): string | undefined {
  const i = args.indexOf("--role");
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || !ROLE_VALUE_RE.test(value)) {
    throw new RoleFlagError(
      "nimbus init: --role needs a value such as product, engineering, design or other.",
    );
  }
  return value;
}

type PackRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly roles: readonly string[];
  readonly installed: boolean;
  readonly visibleAgents: readonly string[];
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stringList(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function rowsOf(v: unknown, installed: boolean): PackRow[] {
  if (!Array.isArray(v)) return [];
  const out: PackRow[] = [];
  for (const raw of v) {
    const r = asRecord(raw);
    const id = r?.["id"];
    const name = r?.["name"];
    if (r === undefined || typeof id !== "string" || typeof name !== "string") continue;
    const description = r["description"];
    out.push({
      id,
      name,
      description: typeof description === "string" ? description : undefined,
      roles: stringList(r["roles"]),
      installed,
      visibleAgents: stringList(r["visibleAgents"]),
    });
  }
  return out;
}

/** Installed packs first, then available, in list order, one row per id. */
function packRows(packList: unknown): readonly PackRow[] {
  const r = asRecord(packList);
  const all = [...rowsOf(r?.["installed"], true), ...rowsOf(r?.["available"], false)];
  return all.filter((row, i) => all.findIndex((x) => x.id === row.id) === i);
}

/** One choice per pack (its `name`), then Engineering, Design, Something else. */
export function roleChoices(packList: unknown): readonly RoleChoice[] {
  const packs = packRows(packList).map(
    (p): RoleChoice => ({
      value: `pack:${p.id}`,
      label: stripControlChars(p.name),
      ...(p.description === undefined ? {} : { hint: stripControlChars(p.description) }),
    }),
  );
  return [...packs, ...FIXED_ROLES.map((r) => ({ value: r, label: FIXED_LABEL[r] }))];
}

/** A chosen value or a `--role` value: `pack:<id>`, a pack id, a pack role tag, or a fixed role. */
export function resolveRole(value: string, packList: unknown): RoleAnswer | undefined {
  if ((FIXED_ROLES as readonly string[]).includes(value)) {
    return { kind: value as FixedRole };
  }
  const rows = packRows(packList);
  const id = value.startsWith("pack:") ? value.slice("pack:".length) : value;
  const row = rows.find((p) => p.id === id) ?? rows.find((p) => p.roles.includes(value));
  return row === undefined
    ? undefined
    : { kind: "pack", packId: row.id, name: row.name, installed: row.installed };
}

/** The values `--role` accepts on this install, for the unknown-role message. */
export function acceptedRoleValues(packList: unknown): readonly string[] {
  const out: string[] = [];
  for (const p of packRows(packList)) {
    for (const v of [p.id, ...p.roles]) if (!out.includes(v)) out.push(v);
  }
  return [...out, ...FIXED_ROLES];
}

function isSignIn(v: unknown): v is SignInKind {
  return v === "browser" || v === "atlassian" || v === "terminal";
}

/**
 * `catalog.list`'s suggestions in order, each with its catalog display name and sign-in kind, and
 * whether `connector.listStatus` shows it connected (a status row whose `healthState` is present
 * and not `unauthenticated` — the desktop's rule).
 */
export function connectorSuggestions(
  catalog: unknown,
  statuses: unknown,
): readonly ConnectorSuggestion[] {
  const c = asRecord(catalog);
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(c?.["connectors"]) ? (c["connectors"] as unknown[]) : []) {
    const r = asRecord(raw);
    if (r === undefined) continue;
    // An installed extension is suggested by its service id (`ext_*`), not its package id.
    for (const key of [r["id"], r["serviceId"]]) if (typeof key === "string") byId.set(key, r);
  }
  const connected = new Set<string>();
  for (const raw of Array.isArray(statuses) ? statuses : []) {
    const r = asRecord(raw);
    const id = r?.["serviceId"];
    const health = r?.["healthState"];
    if (typeof id === "string" && typeof health === "string" && health !== "unauthenticated") {
      connected.add(id);
    }
  }
  return stringList(c?.["suggestedConnectors"]).map((id) => {
    const row = byId.get(id);
    const displayName = row?.["displayName"] ?? row?.["name"];
    const signIn = row?.["signIn"];
    return {
      id,
      displayName: stripControlChars(typeof displayName === "string" ? displayName : id),
      signIn: isSignIn(signIn) ? signIn : "terminal",
      connected: connected.has(id),
    };
  });
}

export interface RoleStepDeps {
  readonly interactive: boolean;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  /** One gateway call (`pack.list`, `catalog.list`, `connector.listStatus`). */
  readonly call: (method: string, params?: unknown) => Promise<unknown>;
  /** The question; `undefined` when the person cancelled. */
  readonly selectRole: (choices: readonly RoleChoice[]) => Promise<string | undefined>;
  /** `nimbus pack install <id>` on a terminal-answered approval; returns its exit code. */
  readonly installPack: (packId: string) => Promise<number>;
  readonly confirmConnect: (displayName: string) => Promise<boolean>;
  /** `connector.auth { service }` with the interactive (browser) timeout. */
  readonly connectorAuth: (serviceId: string) => Promise<void>;
}

function errorText(e: unknown): string {
  return stripControlChars(e instanceof Error ? e.message : String(e));
}

async function askRole(packList: unknown, deps: RoleStepDeps): Promise<RoleAnswer> {
  if (!deps.interactive) return { kind: "other" };
  const picked = await deps.selectRole(roleChoices(packList));
  return (picked === undefined ? undefined : resolveRole(picked, packList)) ?? { kind: "other" };
}

async function packStep(
  answer: Extract<RoleAnswer, { kind: "pack" }>,
  deps: RoleStepDeps,
): Promise<void> {
  const name = stripControlChars(answer.name);
  if (answer.installed) {
    deps.log(`The ${name} pack is already installed.`);
    return;
  }
  if (!deps.interactive) {
    deps.log(`Next: nimbus pack install ${answer.packId}`);
    return;
  }
  deps.log(
    `The ${name} pack sets Nimbus up for this role. You'll be asked to approve exactly what it changes.`,
  );
  if ((await deps.installPack(answer.packId)) !== 0) {
    deps.log(`The ${name} pack was not installed; continuing without it.`);
  }
}

async function connectorStep(answer: RoleAnswer, deps: RoleStepDeps): Promise<void> {
  // Read after the pack step, so a just-installed pack's suggestions and visible agents are the
  // ones shown.
  const packList = answer.kind === "pack" ? await deps.call("pack.list", {}) : undefined;
  const installedRow =
    answer.kind === "pack"
      ? packRows(packList).find((p) => p.id === answer.packId && p.installed)
      : undefined;
  const [catalog, statuses] = await Promise.all([
    deps.call("catalog.list", {}),
    deps.call("connector.listStatus", {}),
  ]);
  const rows = connectorSuggestions(catalog, statuses);
  const label =
    installedRow === undefined ? "getting started" : stripControlChars(installedRow.name);
  deps.log("");
  deps.log(`Connectors for ${label}:`);
  for (const r of rows) {
    deps.log(
      r.connected
        ? `  ${r.displayName}  connected`
        : `  ${r.displayName}  not connected — nimbus connector auth ${r.id}`,
    );
  }
  if (deps.interactive) {
    for (const r of rows) {
      if (r.connected || r.signIn !== "browser") continue;
      if (!(await deps.confirmConnect(r.displayName))) continue;
      try {
        await deps.connectorAuth(r.id);
        deps.log(`  ${r.displayName}: connected.`);
      } catch (e) {
        deps.error(`  ${r.displayName}: ${errorText(e)}`);
      }
    }
  }
  if (installedRow?.visibleAgents.includes("decisions") === true) {
    deps.log("");
    deps.log("Nimbus looks for decisions after your connectors sync: nimbus decisions");
  }
}

/**
 * Ask (or take `flagRole`), then — for a pack answer — the pack step, and for every answer but
 * Engineering the connector step. Engineering returns straight away: its flow is today's (the
 * caller runs the login-adoption offer). `unknown-role` means a `--role` value no pack and no
 * fixed role matches; nothing was changed, and `message` names what this install accepts.
 */
export async function runRoleStep(
  flagRole: string | undefined,
  deps: RoleStepDeps,
): Promise<RoleAnswer | UnknownRole> {
  const packList = await deps.call("pack.list", {});
  let answer: RoleAnswer;
  if (flagRole === undefined) {
    answer = await askRole(packList, deps);
  } else {
    const resolved = resolveRole(flagRole, packList);
    if (resolved === undefined) {
      return { kind: "unknown-role", message: unknownRoleMessage(flagRole, packList) };
    }
    answer = resolved;
  }
  if (answer.kind === "engineering") return answer;
  if (answer.kind === "pack") await packStep(answer, deps);
  await connectorStep(answer, deps);
  return answer;
}

function unknownRoleMessage(value: string, packList: unknown): string {
  return `nimbus init: unknown --role "${stripControlChars(value)}". Use one of: ${acceptedRoleValues(packList).join(", ")}.`;
}
