/** Size and count limits every registry package is held to, by the publisher and every client. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRY_COUNT = 5000;
/** A role-pack manifest document. Above `MAX_MANIFEST_BYTES` because a 64 KiB `defaults` grows under JSON escaping. */
export const MAX_ROLE_PACK_MANIFEST_BYTES = 128 * 1024;
/** A role pack's `defaults` TOML fragment, in UTF-8 bytes; equal to the gateway's pack-fragment cap. */
export const MAX_ROLE_PACK_DEFAULTS_BYTES = 65_536;
