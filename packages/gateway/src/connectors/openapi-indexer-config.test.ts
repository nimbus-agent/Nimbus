import { expect, test } from "bun:test";
import { DEFAULT_OPENAPI_CONFIG, parseOpenapiToml } from "./openapi-indexer-config.ts";

test("missing [openapi] block returns defaults", () => {
  expect(parseOpenapiToml("")).toEqual(DEFAULT_OPENAPI_CONFIG);
});

test("parses max_walk_depth and max_spec_bytes when set", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 12
max_spec_bytes = 10485760
`);
  expect(cfg.maxWalkDepth).toBe(12);
  expect(cfg.maxSpecBytes).toBe(10485760);
});

test("parses ignore_globs as comma-separated string list", () => {
  const cfg = parseOpenapiToml(`
[openapi]
ignore_globs = "**/legacy/**, **/archived/**"
`);
  expect(cfg.ignoreGlobs).toEqual(["**/legacy/**", "**/archived/**"]);
});

test("invalid integer falls back to default value silently", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = "not a number"
`);
  expect(cfg.maxWalkDepth).toBe(DEFAULT_OPENAPI_CONFIG.maxWalkDepth);
});

// --- stripComment branch: line with '#' comment ---
test("strips inline comments from lines", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 5 # this is a comment
`);
  expect(cfg.maxWalkDepth).toBe(5);
});

test("ignores comment-only lines", () => {
  const cfg = parseOpenapiToml(`
# this whole line is a comment
[openapi]
# another comment
max_walk_depth = 3
`);
  expect(cfg.maxWalkDepth).toBe(3);
});

// --- CRLF line endings ---
test("handles CRLF line endings", () => {
  const cfg = parseOpenapiToml("[openapi]\r\nmax_walk_depth = 6\r\n");
  expect(cfg.maxWalkDepth).toBe(6);
});

// --- Lines before any block are skipped ---
test("key=value lines before any block are ignored", () => {
  const cfg = parseOpenapiToml(`
max_walk_depth = 99
[openapi]
max_walk_depth = 4
`);
  expect(cfg.maxWalkDepth).toBe(4);
});

// --- Non-openapi section heading ---
test("lines in non-openapi block are ignored", () => {
  const cfg = parseOpenapiToml(`
[other]
max_walk_depth = 99
[openapi]
max_walk_depth = 7
`);
  expect(cfg.maxWalkDepth).toBe(7);
});

// --- inBlock reverts to false on new non-openapi section ---
test("stops reading openapi values when a new section starts", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 5
[other]
max_walk_depth = 99
`);
  expect(cfg.maxWalkDepth).toBe(5);
});

// --- eq <= 0: line with '=' at position 0 is skipped ---
test("key=value line with empty key (eq at position 0) is skipped", () => {
  const cfg = parseOpenapiToml(`
[openapi]
= some_value
max_walk_depth = 3
`);
  expect(cfg.maxWalkDepth).toBe(3);
});

// --- eq <= 0: line with no '=' is skipped ---
test("key=value line with no equals sign is skipped", () => {
  const cfg = parseOpenapiToml(`
[openapi]
no_equals_sign_here
max_walk_depth = 2
`);
  expect(cfg.maxWalkDepth).toBe(2);
});

// --- max_walk_depth out-of-range bounds (< 1) ---
test("max_walk_depth below minimum (0) falls back to default", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 0
`);
  expect(cfg.maxWalkDepth).toBe(DEFAULT_OPENAPI_CONFIG.maxWalkDepth);
});

// --- max_walk_depth out-of-range bounds (> 64) ---
test("max_walk_depth above maximum (65) falls back to default", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 65
`);
  expect(cfg.maxWalkDepth).toBe(DEFAULT_OPENAPI_CONFIG.maxWalkDepth);
});

// --- max_walk_depth negative (< 1) ---
test("max_walk_depth negative falls back to default", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = -1
`);
  expect(cfg.maxWalkDepth).toBe(DEFAULT_OPENAPI_CONFIG.maxWalkDepth);
});

// --- max_walk_depth at boundary values (1 and 64) ---
test("max_walk_depth at minimum boundary value 1 is accepted", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 1
`);
  expect(cfg.maxWalkDepth).toBe(1);
});

test("max_walk_depth at maximum boundary value 64 is accepted", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_walk_depth = 64
`);
  expect(cfg.maxWalkDepth).toBe(64);
});

// --- max_spec_bytes out-of-range (< 1024) ---
test("max_spec_bytes below minimum (1023) falls back to default", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_spec_bytes = 1023
`);
  expect(cfg.maxSpecBytes).toBe(DEFAULT_OPENAPI_CONFIG.maxSpecBytes);
});

// --- max_spec_bytes out-of-range (> 1 GiB) ---
test("max_spec_bytes above maximum falls back to default", () => {
  const tooBig = 1024 * 1024 * 1024 + 1;
  const cfg = parseOpenapiToml(`
[openapi]
max_spec_bytes = ${tooBig}
`);
  expect(cfg.maxSpecBytes).toBe(DEFAULT_OPENAPI_CONFIG.maxSpecBytes);
});

// --- max_spec_bytes at boundary values ---
test("max_spec_bytes at minimum boundary 1024 is accepted", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_spec_bytes = 1024
`);
  expect(cfg.maxSpecBytes).toBe(1024);
});

test("max_spec_bytes at maximum boundary 1073741824 is accepted", () => {
  const limit = 1024 * 1024 * 1024;
  const cfg = parseOpenapiToml(`
[openapi]
max_spec_bytes = ${limit}
`);
  expect(cfg.maxSpecBytes).toBe(limit);
});

// --- max_spec_bytes with non-integer value ---
test("max_spec_bytes with non-integer string falls back to default", () => {
  const cfg = parseOpenapiToml(`
[openapi]
max_spec_bytes = 1.5
`);
  expect(cfg.maxSpecBytes).toBe(DEFAULT_OPENAPI_CONFIG.maxSpecBytes);
});

// --- Unknown key is silently ignored ---
test("unknown key in [openapi] block is silently ignored", () => {
  const cfg = parseOpenapiToml(`
[openapi]
unknown_key = some_value
max_walk_depth = 9
`);
  expect(cfg.maxWalkDepth).toBe(9);
  expect(cfg.maxSpecBytes).toBe(DEFAULT_OPENAPI_CONFIG.maxSpecBytes);
  expect(cfg.ignoreGlobs).toEqual(DEFAULT_OPENAPI_CONFIG.ignoreGlobs);
});

// --- parseGlobList: ignore_globs with non-quoted value returns empty array ---
test("ignore_globs without quotes returns empty list", () => {
  const cfg = parseOpenapiToml(`
[openapi]
ignore_globs = **/legacy/**
`);
  expect(cfg.ignoreGlobs).toEqual([]);
});

// --- parseGlobList: empty-string entries in comma list are filtered out ---
test("ignore_globs with extra commas filters empty strings", () => {
  const cfg = parseOpenapiToml(`
[openapi]
ignore_globs = "**/a/**, , **/b/**"
`);
  expect(cfg.ignoreGlobs).toEqual(["**/a/**", "**/b/**"]);
});

// --- parseStringScalar: single quote char (length 1) returns undefined, so no globs ---
test("ignore_globs with a bare single double-quote is treated as non-quoted", () => {
  const cfg = parseOpenapiToml(`
[openapi]
ignore_globs = "
`);
  // A single '"' starts and ends with '"' but length < 2 so parseStringScalar returns undefined
  // parseGlobList then returns []
  expect(cfg.ignoreGlobs).toEqual([]);
});

// --- ignore_globs with empty quoted string produces empty list ---
test("ignore_globs with empty quoted string produces empty list", () => {
  const cfg = parseOpenapiToml(`
[openapi]
ignore_globs = ""
`);
  expect(cfg.ignoreGlobs).toEqual([]);
});

// --- ignore_globs with single entry (no commas) ---
test("ignore_globs with single quoted glob entry", () => {
  const cfg = parseOpenapiToml(`
[openapi]
ignore_globs = "**/test/**"
`);
  expect(cfg.ignoreGlobs).toEqual(["**/test/**"]);
});

// --- Multiple sections: only [openapi] values are read ---
test("only values from [openapi] section are applied", () => {
  const cfg = parseOpenapiToml(`
[database]
max_walk_depth = 50
[openapi]
max_walk_depth = 10
[network]
max_walk_depth = 99
`);
  expect(cfg.maxWalkDepth).toBe(10);
});

// --- DEFAULT_OPENAPI_CONFIG shape validation ---
test("DEFAULT_OPENAPI_CONFIG has expected shape", () => {
  expect(DEFAULT_OPENAPI_CONFIG.maxWalkDepth).toBe(8);
  expect(DEFAULT_OPENAPI_CONFIG.maxSpecBytes).toBe(5 * 1024 * 1024);
  expect(DEFAULT_OPENAPI_CONFIG.ignoreGlobs).toEqual([]);
});
