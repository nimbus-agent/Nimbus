// packages/gateway/src/connectors/connector-writes/iac-limits.ts
// The size and shape limits of the plan-bound IaC writes (Phase 9.7 D2, spec § 15.5), one table,
// the fixed refusal reasons, and the two PURE input checks the iac rows hand to the prepare step
// (`PrepareRead.inputRefusal`). Imports nothing from the row table, the executor or the dispatcher.
// The connector's own caps (`connectors/iac/src/tools.ts`: plan file 64 MiB, plan JSON 4 MiB, 500
// changes, template 51,200 bytes) are the outer bound; the gateway is tighter where it must SHOW
// the result in full (a plan file 16 MiB, rendered text 64 KiB), and a plan that exceeds a cap is
// refused, never truncated: the owner never approves what the preview cannot show.

/** The caps and budgets of an iac write the gateway will prepare and show. */
export const IAC_LIMITS = Object.freeze({
  /** The gateway's cap on the saved plan file it moves, hashes and shows (connector: 64 MiB). */
  maxPlanFileBytes: 16 * 1024 * 1024,
  /** `terraform show -json` output (the connector's own cap). */
  maxPlanJsonBytes: 4 * 1024 * 1024,
  /** Non-no-op resource changes shown (also the connector's change-set cap). */
  maxChanges: 500,
  /** UTF-8 bytes of the rendered, escaped plan text. */
  maxRenderedBytes: 65_536,
  /** A scalar attribute value longer than this is named, not shown. */
  maxValueChars: 120,
  /** The CloudFormation template, as UTF-8 (what `create-change-set --template-body` takes). */
  maxTemplateBytes: 51_200,
  /** The longest workdir the confirm text `iac/destroy <path>` can carry (`CONFIRM_MAX_LENGTH` 200). */
  maxWorkdirChars: 180,
  /** CloudFormation allows 128 characters in a stack name. */
  maxStackNameChars: 128,
  /** The show child (no network, reads one local file). */
  showBudgetMs: 120_000,
  terraform: Object.freeze({
    /** One timer over the plan child (a plan refreshes real infrastructure). */
    budgetMs: 10 * 60_000,
    maxInputChars: 4096,
    maxReplyChars: 64 * 1024,
  }),
  cfn: Object.freeze({
    /** The connector polls 120 s, plus `describe-stacks` and `create-change-set`. */
    budgetMs: 150_000,
    maxInputChars: 64 * 1024,
    maxReplyChars: 262_144,
  }),
});

/**
 * The dispatcher's per-call race for the iac tools, by bare tool id (D2 task 5). The generic 60 s
 * race would kill a plan or an apply long before it can finish. Each is the OUTER bound over a
 * prepare step's own budget (`terraform.budgetMs`, `cfn.budgetMs`), which fires first. An apply
 * that outlives its budget is killed by the runner and reported as possibly partly changed.
 */
export const IAC_TOOL_TIMEOUTS_MS: Readonly<Record<string, number>> = Object.freeze({
  iac_terraform_plan: 10 * 60_000,
  iac_terraform_destroy_plan: 10 * 60_000,
  iac_terraform_show_json: 120_000,
  iac_cloudformation_changeset_create: 180_000,
  iac_terraform_apply: 30 * 60_000,
  iac_terraform_destroy: 30 * 60_000,
  iac_cloudformation_deploy: 60_000,
  iac_cloudformation_changeset_discard: 60_000,
});

/**
 * Every reason an iac input check can give: fixed text, never built from the input (so an input
 * cannot put its own words in front of the model or the owner).
 */
export const IAC_INPUT_REFUSALS = Object.freeze({
  inputInvalid: "iac: the input is not an object",
  fieldNotTaken: "iac: the input has a field this write does not take",
  workdirInvalid: "iac: the working directory must be a non-empty string",
  workdirTooLong: "iac: the working directory path is too long",
  workdirUnshowable: "iac: the working directory path has a character that cannot be shown",
  workdirNotAbsolute: "iac: the working directory must be an absolute path",
  workdirNotCanonical: "iac: the working directory must be a plain absolute path",
  stackNameInvalid: "iac: the stack name is not a plain stack name",
  templateInvalid: "iac: the template must be non-empty text without a NUL or a lone surrogate",
  templateTooLarge: "iac: the template is over 51,200 bytes",
  capabilitiesInvalid: "iac: capabilities must be a list of at most three known capabilities",
  capabilitiesDuplicate: "iac: capabilities must not repeat a value",
});

/** The top-level input keys of the Terraform rows (pinned against the connector schemas). */
export const TERRAFORM_INPUT_KEYS: readonly string[] = Object.freeze(["workingDirectory"]);

/**
 * The CloudFormation deploy's own keys minus `changeSetId`, which the gateway binds. Any other key
 * would be rendered into the owner's prompt as an "other field", so it is refused instead.
 */
export const CFN_INPUT_KEYS: readonly string[] = Object.freeze([
  "stackName",
  "templateBody",
  "capabilities",
]);

/** The three values `create-change-set --capabilities` takes (the connector's own enum). */
const CFN_CAPABILITIES: readonly string[] = Object.freeze([
  "CAPABILITY_IAM",
  "CAPABILITY_NAMED_IAM",
  "CAPABILITY_AUTO_EXPAND",
]);

/** A character the preview cannot be trusted to show as it is (control, format, separators, surrogates). */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
/** A stack name: AWS allows a letter first, then letters, digits and hyphens. Stricter than an ARN. */
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((k) => allowed.includes(k));
}

/** A path segment list is plain: no empty, `.` or `..` segment (so no `//`, trailing separator or root). */
function plainSegments(segments: readonly string[]): boolean {
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * Why a Terraform workdir is refused by SHAPE alone, or `undefined`. This is the pure half of the
 * workdir rule (the gate's preflight adds the filesystem half: the path must equal its own
 * canonical form and lie inside an owner-approved directory). It accepts an absolute path in
 * POSIX form (`/a/b`, no backslash) or Windows drive form (`C:\a\b` or `C:/a/b`, no `:` after the
 * drive), made only of plain segments. A UNC, device or relative form, a `..`, `.` or empty
 * segment, a trailing separator, a filesystem root, a control or format character, a path that is
 * not NFC-normalised and a path over 180 characters are refused. PURE and fixed-text.
 */
function workdirShapeRefusal(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return IAC_INPUT_REFUSALS.workdirInvalid;
  if (value.length > IAC_LIMITS.maxWorkdirChars) return IAC_INPUT_REFUSALS.workdirTooLong;
  if (UNSHOWABLE.test(value) || value.normalize("NFC") !== value) {
    return IAC_INPUT_REFUSALS.workdirUnshowable;
  }
  if (WINDOWS_DRIVE.test(value)) {
    const rest = value.slice(3).split(/[\\/]/u);
    return plainSegments(rest) && !rest.some((s) => s.includes(":"))
      ? undefined
      : IAC_INPUT_REFUSALS.workdirNotCanonical;
  }
  if (!value.startsWith("/")) return IAC_INPUT_REFUSALS.workdirNotAbsolute;
  if (value.includes("\\")) return IAC_INPUT_REFUSALS.workdirNotCanonical;
  return plainSegments(value.slice(1).split("/"))
    ? undefined
    : IAC_INPUT_REFUSALS.workdirNotCanonical;
}

/**
 * `PrepareRead.inputRefusal` of the Terraform rows: the input is exactly `{ workingDirectory }`
 * and that is a plainly-shaped absolute path. Run before any read or prompt.
 */
export function terraformInputRefusal(
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!isRecord(input)) return IAC_INPUT_REFUSALS.inputInvalid;
  if (!onlyKeys(input, TERRAFORM_INPUT_KEYS)) return IAC_INPUT_REFUSALS.fieldNotTaken;
  return workdirShapeRefusal(
    Object.hasOwn(input, "workingDirectory") ? input["workingDirectory"] : undefined,
  );
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function templateRefusal(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return IAC_INPUT_REFUSALS.templateInvalid;
  // Characters first: cheap, and bounds the scans below. UTF-16 units never undercount bytes / 3.
  if (value.length > IAC_LIMITS.maxTemplateBytes) return IAC_INPUT_REFUSALS.templateTooLarge;
  if (value.includes("\u0000") || !value.isWellFormed()) return IAC_INPUT_REFUSALS.templateInvalid;
  if (utf8Length(value) > IAC_LIMITS.maxTemplateBytes) return IAC_INPUT_REFUSALS.templateTooLarge;
  return undefined;
}

function capabilitiesRefusal(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CFN_CAPABILITIES.length) {
    return IAC_INPUT_REFUSALS.capabilitiesInvalid;
  }
  const list: unknown[] = value;
  if (!list.every((c) => typeof c === "string" && CFN_CAPABILITIES.includes(c))) {
    return IAC_INPUT_REFUSALS.capabilitiesInvalid;
  }
  return new Set(list).size === list.length ? undefined : IAC_INPUT_REFUSALS.capabilitiesDuplicate;
}

/**
 * `PrepareRead.inputRefusal` of the CloudFormation deploy: the connector's own cheap rules run
 * again on the gateway side, before any `create-change-set` (which creates an AWS object):
 * only the declared keys, a plain stack name, a well-formed template of at most 51,200 UTF-8
 * bytes, and a duplicate-free list of known capabilities. PURE and fixed-text.
 */
export function cfnInputRefusal(input: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(input)) return IAC_INPUT_REFUSALS.inputInvalid;
  if (!onlyKeys(input, CFN_INPUT_KEYS)) return IAC_INPUT_REFUSALS.fieldNotTaken;
  const stack = Object.hasOwn(input, "stackName") ? input["stackName"] : undefined;
  if (
    typeof stack !== "string" ||
    stack.length > IAC_LIMITS.maxStackNameChars ||
    !STACK_NAME.test(stack)
  ) {
    return IAC_INPUT_REFUSALS.stackNameInvalid;
  }
  const template = templateRefusal(
    Object.hasOwn(input, "templateBody") ? input["templateBody"] : undefined,
  );
  if (template !== undefined) return template;
  return capabilitiesRefusal(
    Object.hasOwn(input, "capabilities") ? input["capabilities"] : undefined,
  );
}

/**
 * The CloudFormation change-set discard (a connector WRITE, fix 19), named once. Only the executor's
 * own cleanup of a change set the same gate run created may call it without a prompt (static D43),
 * and the dispatcher pins the action type to this tool alone.
 */
export const IAC_DISCARD = Object.freeze({
  toolId: "iac_cloudformation_changeset_discard",
  actionType: "iac.cloudformation.changeset.discard",
});

/**
 * The reasons the preflight capability refuses a bound iac write with (fixed text, never the path):
 * the approved-directory and cloud-credential checks and the one-run-per-directory lock. The model
 * door passes these back verbatim as `{ refused }` (no prompt happened).
 */
export const IAC_PREFLIGHT_REFUSALS = Object.freeze({
  notApprovedDirectory: "iac: the working directory is not an approved directory",
  noCloudCredential: "iac: no cloud credential is granted for this change",
  busy: "iac: another run is using this working directory",
});

/** What the MODEL door alone refuses for an iac write (the owner's doors are not restricted). */
export const IAC_MODEL_REFUSALS = Object.freeze({
  iamCapability:
    "iac: IAM capabilities are not available to the model; the owner applies those themselves",
});

const IAM_CAPABILITIES: ReadonlySet<string> = new Set(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);

/**
 * The model-door refusal of an iac write, pure and input-only: a CloudFormation deploy asking for an
 * IAM capability (a model creating roles and users). A malformed `capabilities` is left to the
 * row's own input hook, which refuses it with its own fixed text.
 */
export function iacModelRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (toolId !== "iac_cloudformation_deploy") return undefined;
  const capabilities: unknown = Object.hasOwn(input, "capabilities")
    ? input["capabilities"]
    : undefined;
  if (!Array.isArray(capabilities)) return undefined;
  return (capabilities as unknown[]).some((c) => typeof c === "string" && IAM_CAPABILITIES.has(c))
    ? IAC_MODEL_REFUSALS.iamCapability
    : undefined;
}
