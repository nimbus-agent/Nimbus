// packages/gateway/src/engine/iac-orphan.ts
// The change set a CloudFormation prepare step may have LEFT behind (Phase 9.7 D2, static D43).
// When the connector created a change set but the gate then refuses (the plan is too large to show,
// a name or ARN does not match, the reply is too big), the settled values never exist, so the
// executor's discard has nothing to name. This derives a discard target from the prepare reply
// ALONE and only when the gateway can validate every part of it against its own input: the stack is
// the caller's, the change set NAME is `nimbus-<sha256 of the caller's template>-<12 hex>` (the
// gateway computes the hash), and the ARN's name segment is that name. Anything else is not a
// target: the gateway never guesses what to delete. Pure; imports nothing from the executor.
import { createHash } from "node:crypto";

/** The one thing the discard step may remove: this stack's change set with this ARN. */
export interface CfnOrphan {
  readonly stackName: string;
  readonly changeSetId: string;
}

const ARN =
  /^arn:aws[a-z-]*:cloudformation:[a-z0-9-]+:\d{12}:changeSet\/(nimbus-[0-9a-f]{64}-[0-9a-f]{12})\/[0-9a-f-]{36}$/;

function field(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null && Object.hasOwn(o, key)
    ? (o as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The change set the prepare reply names, or `undefined` unless the reply, cross-checked against
 * the caller's input, proves it is one this run's template created for this run's stack.
 */
export function deriveCfnOrphan(input: unknown, reply: unknown): CfnOrphan | undefined {
  const stackName = field(input, "stackName");
  const templateBody = field(input, "templateBody");
  const replyStack = field(reply, "stackName");
  const name = field(reply, "changeSetName");
  const id = field(reply, "changeSetId");
  if (
    typeof stackName !== "string" ||
    typeof templateBody !== "string" ||
    replyStack !== stackName ||
    typeof name !== "string" ||
    typeof id !== "string"
  ) {
    return undefined;
  }
  const sha = createHash("sha256").update(templateBody, "utf8").digest("hex");
  if (!new RegExp(`^nimbus-${sha}-[0-9a-f]{12}$`).test(name)) return undefined;
  const arn = ARN.exec(id);
  return arn?.[1] === name ? { stackName, changeSetId: id } : undefined;
}
