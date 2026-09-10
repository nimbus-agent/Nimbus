import type { ExtensionManifest } from "../extensions/manifest.ts";

/** Scalar types supported in generated-tool parameters. */
export type ToolInputScalar = "string" | "number" | "boolean";

/** A single property in the generated tool's input schema. */
export type ToolInputProperty =
  | { readonly type: ToolInputScalar; readonly description?: string }
  | {
      readonly type: "array";
      readonly items: { readonly type: ToolInputScalar };
      readonly description?: string;
    };

/** The restricted JSON-Schema subset describing a generated tool's parameters. */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ToolInputProperty>>;
  readonly required?: readonly string[];
}

/**
 * The custom MCP method a generated tool uses to ask the gateway to make a request for it.
 *
 * Defined ONCE here and imported by `toolgen-stub.ts` (which emits it into the generated skeleton)
 * and `toolgen-broker.ts` (which serves it). Static rule D29(a) confines the literal to this file:
 * a producer and a consumer that separately hardcode the same string are two copies that can drift
 * invisibly — the exact failure `SANDBOX_POLICY_ENV` documents for its own wire.
 */
export const BROKERED_FETCH_METHOD = "nimbus/fetch";

/** Named codes so a caller distinguishes refusals without matching on message text. */
export class ToolgenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /**
     * Set only by `draftGeneratedTool` on `ERR_TOOLGEN_DRAFT_INVALID`, where a model DID answer
     * and the CLI's local-model hint needs to know whether it was the local route. Optional and
     * `undefined` on every other refusal -- most (disabled/policy/budget/bad host/confinement) are
     * decided before a draft is even attempted and have no locality to report. A real field on the
     * error, never smuggled into `message` and parsed back out -- a parsed message is not a
     * contract.
     */
    readonly locality?: "local" | "remote",
  ) {
    super(message);
    this.name = "ToolgenError";
  }
}

/**
 * How the broker attaches a secret. A tagged envelope rather than a bare string: a bare string
 * would force either a convention ("assume Bearer") or a tool-supplied hint, and the second is the
 * tool telling the broker how to spend a credential it cannot see.
 */
export type ToolCredentialBinding =
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "header"; readonly headerName: string; readonly value: string }
  | { readonly type: "basic"; readonly username: string; readonly password: string };

/**
 * Everything the owner approves, hashed into the audit row, and (in PR 3) signed — ONE object so
 * the three can never diverge.
 *
 * `credentialHosts` lists the hosts for which a Vault binding exists at approval time. It is part
 * of the artifact because "this tool will send a credential to X" is a fact the owner is
 * consenting to, so a later change to it must invalidate the approval.
 */
export interface GeneratedToolArtifact {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  /** The VERBATIM model-authored body. Never a digest at the approval prompt. */
  readonly body: string;
  readonly approvedHosts: readonly string[];
  readonly credentialHosts: readonly string[];
  readonly manifest: ExtensionManifest;
  /**
   * The parameters the owner approved.
   *
   * INSIDE the canonical artifact, not beside it: "this tool takes a repo name and a page number"
   * is part of what is being consented to, it is covered by `artifactDigest`, and PR 3 signs it —
   * so a later change to the parameters invalidates the approval, exactly as `credentialHosts`
   * already does.
   */
  readonly inputSchema: ToolInputSchema;
}

/** A registered, live tool: the approved artifact plus its runtime bookkeeping. */
export interface ToolgenEnvelope {
  readonly artifact: GeneratedToolArtifact;
  readonly sessionId: string;
  readonly scriptPath: string;
  readonly approvedAt: number;
}

export interface CreateGeneratedToolRequest {
  readonly sessionId: string;
  readonly description: string;
  readonly hosts: readonly string[];
}

/**
 * What the gate has already resolved by the time it drafts. Both lists are NORMALISED host names
 * and `credentialHosts` is a subset of `hosts`.
 */
export interface DraftSubject {
  readonly hosts: readonly string[];
  /** Hosts that will carry a credential. NAMES ONLY — never a secret (spec § 9.1). */
  readonly credentialHosts: readonly string[];
}

/**
 * One host's credential, as it crosses `toolgen.create`.
 *
 * A SEPARATE parameter to `createGeneratedTool`, never a field of `CreateGeneratedToolRequest`:
 * the gate hands the request straight to `draftTool`, so a `credentials` field on the request
 * would place raw tokens on the input to a drafting prompt — and a secret in a remote model's
 * context has left the machine (spec § 9.1). NEVER reaches a drafting prompt.
 */
export interface ToolCredentialParam {
  readonly host: string;
  readonly binding: ToolCredentialBinding;
}

export interface DraftGeneration {
  readonly text: string;
  readonly isLocal: boolean;
}

/**
 * The manifest fields that are SIGNED. Deliberately excludes `filesystem.read`, whose entries are
 * machine-derived absolute paths (`dirname(process.execPath)`, plus its parent on macOS) — signing
 * those makes a Bun upgrade indistinguishable from tampering (spec § 3.1). The read set is instead
 * reconstructed at spawn and asserted against this shape.
 */
export interface PortableToolManifest {
  readonly id: string;
  readonly version: string;
  readonly updateChannel: string;
  /** Empty by construction — I39. Signed so a non-empty value cannot ride in unnoticed. */
  readonly network: readonly string[];
  /** Empty by construction. Signed for the same reason. */
  readonly filesystemWrite: readonly string[];
}

/** Added in PR 3; see spec § 9's error table. */
export const ERR_TOOLGEN_MANIFEST_SHAPE_INVALID = "ERR_TOOLGEN_MANIFEST_SHAPE_INVALID";
export const ERR_TOOLGEN_CREDENTIAL_REQUIRED = "ERR_TOOLGEN_CREDENTIAL_REQUIRED";
export const ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN = "ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN";
export const ERR_TOOLGEN_SIGNATURE_INVALID = "ERR_TOOLGEN_SIGNATURE_INVALID";
export const ERR_TOOLGEN_SAVE_DISABLED = "ERR_TOOLGEN_SAVE_DISABLED";
export const ERR_TOOLGEN_SAVE_NOT_LIVE = "ERR_TOOLGEN_SAVE_NOT_LIVE";
export const ERR_TOOLGEN_SAVE_DENIED = "ERR_TOOLGEN_SAVE_DENIED";
