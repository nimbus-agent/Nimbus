# Design Review: Clip source metadata (2026-08-20)

Below are comments, questions, and suggested improvements for the `2026-08-20-clip-source-metadata-design.md` specification.

## Open Questions & Clarifications

1. **`leadImage` URL Length Restriction**
   * **Scenario:** Modern CDN images (such as Unsplash, Cloudinary, AWS S3, or Cloudfront) often carry query parameters for resizing, formatting, and access tokens, which easily exceed 200 characters.
   * **Question:** The current design truncates `leadImage` at 200 characters. Truncating a URL will corrupt it, rendering the image broken. To avoid broken image links while protecting the database, could we increase the limit for `leadImage` to 1024 or 2048 characters?

2. **`publishedAt` Numeric Type and Value Range**
   * **Question:** The validator uses `Number.isFinite` to check `publishedAt`. Should we specifically enforce that it is an integer (e.g., `Number.isInteger`) to avoid fractional milliseconds?
   * **Validation Range:** Should we reject or drop dates that are negative (pre-1970) or in the far future (e.g. more than 1 year from the current time) to prevent garbage data from corrupting the index sort order/display?

## Suggested Improvements

1. **Schema Validation for `lang`**
   * **Suggestion:** While length-capping `lang` to 20 characters is a safe defense, language tags are almost never longer than 10 characters (typically BCP-47 tags like `en-US` or `zh-Hans-CN`). If a page sends something longer than 20 characters, it is almost certainly garbage text rather than a valid language identifier. Dropping the field entirely when it exceeds 20 characters (instead of truncating it) might be cleaner and prevent storing corrupted/truncated language tags.
