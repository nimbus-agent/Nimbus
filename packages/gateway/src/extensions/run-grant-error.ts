export type ExtensionRunGrantErrorCode =
  | "ERR_EXTENSION_SERVICE_ID_INVALID"
  | "ERR_EXTENSION_SERVICE_ID_COLLISION"
  | "ERR_EXTENSION_GRANT_PATH_RELATIVE"
  | "ERR_EXTENSION_GRANT_PATH_MISSING"
  | "ERR_EXTENSION_GRANT_PROTECTED"
  | "ERR_EXTENSION_GRANT_SELF_WRITE"
  | "ERR_EXTENSION_NOT_FOUND"
  | "ERR_EXTENSION_RUN_DISABLED"
  | "ERR_EXTENSION_RUN_UNVERIFIED"
  | "ERR_EXTENSION_RUN_NO_DIGEST"
  | "ERR_EXTENSION_RUN_TREE_CHANGED"
  | "ERR_EXTENSION_RUN_NOT_APPROVED"
  | "ERR_EXTENSION_RUN_CHANGED";

/** A refusal on the way to an extension run grant. The code leads the message, so a CLI shows it. */
export class ExtensionRunGrantError extends Error {
  readonly code: ExtensionRunGrantErrorCode;
  constructor(code: ExtensionRunGrantErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExtensionRunGrantError";
    this.code = code;
  }
}
