// The Nimbus commit a release binary was built from. `.github/workflows/release.yml` OVERWRITES
// this file with the tag's commit SHA immediately before each CLI compile; the committed value is
// always `undefined` (a test pins it), so a dev build has no release commit and
// `nimbus registry maintain init --github` refuses without `--action-ref`.
export const NIMBUS_RELEASE_COMMIT: string | undefined = undefined;
