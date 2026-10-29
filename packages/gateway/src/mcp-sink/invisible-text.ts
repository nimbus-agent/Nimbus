/**
 * The invisible-character table now lives in `util/invisible-text.ts` (it is shared with
 * `extensions/` and `packs/`); `mcp-sink/` still owns its use, so this re-exports it.
 */
export {
  type CodePointRange,
  FORMAT_INVISIBLE_RANGES,
  rangesRegExp,
} from "../util/invisible-text.ts";
