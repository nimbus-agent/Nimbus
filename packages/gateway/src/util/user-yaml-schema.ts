import { binaryTag, CORE_SCHEMA, mergeTag, omapTag, pairsTag, setTag } from "js-yaml";

/**
 * The js-yaml schema for YAML a USER wrote: an OpenAPI/AsyncAPI spec under an indexed root, or an
 * Obsidian note's frontmatter.
 *
 * js-yaml 5 loads with the bare YAML 1.2 CORE schema by default, which drops forms js-yaml 4
 * resolved out of the box. Two of those losses are silent and real for user files:
 *
 * - **Merge keys.** `<<: *anchor` became a literal `"<<"` key, so a spec path item assembled from an
 *   anchor indexed none of its operations, and a note's merged frontmatter lost its tags.
 * - **`!!binary`, `!!omap`, `!!pairs`, `!!set`.** Any one of them made the WHOLE document throw, so
 *   one tagged example skipped an entire spec and one tagged property emptied a note's frontmatter.
 *
 * This schema restores both. `!!set` now loads as a JS `Set` (js-yaml 4 built an object whose values
 * were all `null`), which is still better than discarding the document around it.
 *
 * Deliberately NOT restored: implicit timestamps. `created: 2024-01-02` stays the string the user
 * wrote rather than becoming a `Date`, which the index would otherwise store as an ISO instant with a
 * time and zone the user never typed.
 *
 * Two js-yaml 4 forms therefore still throw: an explicit `!!timestamp` tag, and a complex mapping key
 * (`? [a, b]`), which 4 flattened to the string `"a,b"` and 5's object-based map refuses. Restoring
 * the second would take `legacyMapTag`, which js-yaml documents as strongly discouraged.
 *
 * Repo-owned YAML (workflows, the gateway's own OpenAPI document) keeps the default CORE schema: none
 * of it uses these forms, so adding them there would only widen what an input can do.
 */
export const USER_YAML_SCHEMA = CORE_SCHEMA.withTags(
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag,
);
