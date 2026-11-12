// The implementation moved to `util/zoned-time.ts` (Phase 10 MB5): the briefing's static rule D45
// forbids a value import from `connectors/`, and the briefing needs the same wall-to-instant helper.
export * from "../../util/zoned-time.ts";
