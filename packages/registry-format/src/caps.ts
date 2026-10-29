/** Size and count limits every registry package is held to, by the publisher and every client. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRY_COUNT = 5000;
/** A role-pack manifest document. Above `MAX_MANIFEST_BYTES` because a 64 KiB `defaults` grows under JSON escaping. */
export const MAX_ROLE_PACK_MANIFEST_BYTES = 128 * 1024;
/** A role pack's `defaults` TOML fragment, in UTF-8 bytes; equal to the gateway's pack-fragment cap. */
export const MAX_ROLE_PACK_DEFAULTS_BYTES = 65_536;

/** Eval suite limits (`evals/*.eval.json`), held by the parser and by every judge. */
export const MAX_EVAL_SUITES = 20;
export const MAX_EVAL_CASES = 200;
/** One case's `input`, in UTF-8 bytes of its `JSON.stringify`. */
export const MAX_EVAL_INPUT_BYTES = 64 * 1024;
/** One tool reply's text, in bytes. */
export const MAX_EVAL_REPLY_BYTES = 1024 * 1024;
export const MAX_EVAL_JSON_DEPTH = 64;
export const MAX_EVAL_SUITE_FILE_BYTES = 1024 * 1024;
