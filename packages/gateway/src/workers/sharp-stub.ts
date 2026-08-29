/**
 * Falsy stand-in for `sharp`, substituted into the embedding worker bundle.
 *
 * `@xenova/transformers` imports `sharp` statically from `src/utils/image.js` for IMAGE
 * preprocessing, and `sharp` is a native module. Bundled into the worker it fails at load with
 * "Could not load the \"sharp\" module using the <platform> runtime", which killed the whole
 * embedding runtime before a single vector was produced — semantic search dead, and until the
 * logging fix it reported only `err: {}` (#1396).
 *
 * The embedding worker does TEXT feature-extraction only; it never reaches an image path. Two
 * things make stubbing safe rather than a workaround:
 *
 * 1. `image.js` guards its use with `else if (sharp)`, so a falsy value selects the non-sharp
 *    branch by design rather than by accident.
 * 2. Upstream already does exactly this — `@xenova/transformers`'s own manifest maps
 *    `"sharp": false` in its browser field for non-Node builds.
 *
 * If an image or audio model is ever added to this worker, this stub is the first thing to
 * revisit: the failure would be a missing capability at an image path, not a load error.
 */
export default undefined;
