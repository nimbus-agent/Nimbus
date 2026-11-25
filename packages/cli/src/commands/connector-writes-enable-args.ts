/**
 * The argument parsing of `nimbus connector writes enable` (and the `--door` flag `disable` shares),
 * kept apart from the command so each phase reads on its own: scan the flags, then check the scope.
 */

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false /** A second line that says why, when the usage alone would not. */;
      readonly note?: string;
    };

/** The id shape of an owner-registered user MCP server (the gateway's `USER_MCP_SERVICE_ID_PATTERN`). */
export const USER_MCP_ID = /^mcp_[a-z0-9_]{1,62}$/;

/** The approved scope of `enable iac` (D2): every flag repeats, `--cloud` also takes a comma list. */
export interface IacScope {
  workdirs: string[];
  clouds: string[];
  regions: string[];
  net: string[];
}

/** One `--grant <namespace>@<context>`, split at the FIRST `@` (a namespace is a DNS label; a context may hold `@`). */
export interface K8sGrantArg {
  namespace: string;
  context: string;
}

function parseGrantArg(v: string): K8sGrantArg | undefined {
  const at = v.indexOf("@");
  if (at <= 0 || at === v.length - 1) return undefined;
  return { namespace: v.slice(0, at), context: v.slice(at + 1) };
}

const IAC_FLAGS: Readonly<Record<string, keyof IacScope>> = {
  "--workdir": "workdirs",
  "--cloud": "clouds",
  "--region": "regions",
  "--net": "net",
};

/** Takes the value of an `enable iac` scope flag into its list; false when the value is missing. */
function takeIacValue(iac: IacScope, key: keyof IacScope, v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  iac[key].push(...(key === "clouds" ? v.split(",") : [v]));
  return true;
}

export type WaveFlag = 2 | 3 | 4 | undefined;
export type DoorFlag = "model" | "agent" | undefined;

interface EnableFlags {
  wave: WaveFlag;
  iac: IacScope;
  grants: K8sGrantArg[];
  /** `--door agent`: the owner's approval list for outside agents. */
  door: DoorFlag;
  approve: string[];
}

/** Whether `a` is one of the `enable` flags that take a value. */
function isEnableValueFlag(a: string): boolean {
  return (
    a === "--wave" ||
    a === "--grant" ||
    a === "--door" ||
    a === "--approve" ||
    Object.hasOwn(IAC_FLAGS, a)
  );
}

/** `--door agent|model`, given at most once; false for anything else. */
export function takeDoor(flags: { door: DoorFlag }, v: string | undefined): boolean {
  if ((v !== "agent" && v !== "model") || flags.door !== undefined) return false;
  flags.door = v;
  return true;
}

/** Takes one `enable` flag's value into `flags`; false when the value is missing or malformed. */
function takeEnableFlag(flags: EnableFlags, a: string, v: string | undefined): boolean {
  if (a === "--wave") {
    if (v !== "2" && v !== "3" && v !== "4") return false;
    flags.wave = Number(v) as 2 | 3 | 4;
    return true;
  }
  if (a === "--door") return takeDoor(flags, v);
  if (a === "--approve") {
    if (v === undefined || v === "") return false;
    flags.approve.push(v);
    return true;
  }
  if (a === "--grant") {
    const g = parseGrantArg(v ?? "");
    if (g === undefined) return false;
    flags.grants.push(g);
    return true;
  }
  return takeIacValue(flags.iac, IAC_FLAGS[a] as keyof IacScope, v);
}

type EnableValue = {
  service: string;
  wave: WaveFlag;
  iac: IacScope;
  grants: K8sGrantArg[];
  agent: boolean;
  approve: string[];
};

/** The service and the flags, or undefined for a malformed argument list. */
function scanEnableArgs(
  tail: string[],
): { service: string | undefined; flags: EnableFlags } | undefined {
  let service: string | undefined;
  const flags: EnableFlags = {
    wave: undefined,
    iac: { workdirs: [], clouds: [], regions: [], net: [] },
    grants: [],
    door: undefined,
    approve: [],
  };
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] as string;
    if (isEnableValueFlag(a)) {
      if (!takeEnableFlag(flags, a, tail[++i])) return undefined;
    } else if (a.startsWith("-") || service !== undefined) {
      return undefined;
    } else {
      service = a;
    }
  }
  return { service, flags };
}

/** A user MCP server has one door (outside agents) and no waves: say so instead of a bare usage. */
function userMcpEnableNote(agent: boolean, wave: WaveFlag): string | undefined {
  if (!agent) return "A user MCP server is approved for outside agents only: add --door agent.";
  if (wave !== undefined) return "A user MCP server has no waves; do not pass --wave.";
  return undefined;
}

export function parseEnableArgs(tail: string[]): Parsed<EnableValue> {
  const scanned = scanEnableArgs(tail);
  if (scanned?.service === undefined) return { ok: false };
  const { service, flags } = scanned;
  const { wave, iac, grants, approve } = flags;
  const agent = flags.door === "agent";
  const hasIac = Object.values(iac).some((l) => l.length > 0);
  const note = USER_MCP_ID.test(service) ? userMcpEnableNote(agent, wave) : undefined;
  if (note !== undefined) return { ok: false, note };
  // `--approve` belongs to the agent door; the agent door reads the model's scope and takes none.
  if (approve.length > 0 && !agent) return { ok: false };
  if (agent && (hasIac || grants.length > 0)) return { ok: false };
  // The scope flags belong to `iac` alone: any other service would silently ignore them.
  if (!agent && hasIac && service !== "iac") return { ok: false };
  // `--grant` belongs to `kubernetes` alone, and `kubernetes` needs at least one.
  if (!agent && grants.length > 0 !== (service === "kubernetes")) return { ok: false };
  return { ok: true, value: { service, wave, iac, grants, agent, approve } };
}
