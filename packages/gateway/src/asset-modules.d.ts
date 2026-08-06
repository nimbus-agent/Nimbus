/**
 * Ambient shapes for the `{ type: "file" }` imports in `ipc/embedded-assets.ts`.
 *
 * Such an import evaluates to a filesystem path: the real source path under `bun`, and the
 * content-hashed bunfs path inside a `bun build --compile` binary. bun-types already declares
 * `*.html` and `*.yaml`; these two specifier shapes it does not:
 *   - `*.css`             — no declaration at all (TS2307).
 *   - `*​/dist/main.js`    — TypeScript resolves the real `.js` file and, with `allowJs` off,
 *                           reports an implicit `any` (TS7016).
 *   - `*​/dist/index.html` — bun-types declares `*.html` as `HTMLBundle`, which models the
 *                           full-stack bundler import, not `{ type: "file" }`. Under the file
 *                           attribute the import is a path string.
 *
 * Each pattern is scoped to `dist/<name>` so none of them can shadow an ordinary import elsewhere,
 * and so the longer suffix wins the ambient-wildcard match against bun-types' bare `*.html`.
 */
declare module "*.css" {
  const path: string;
  export default path;
}

declare module "*/dist/index.html" {
  const path: string;
  export default path;
}

declare module "*/dist/main.js" {
  const path: string;
  export default path;
}
