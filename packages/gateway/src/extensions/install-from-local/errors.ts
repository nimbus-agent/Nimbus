/** Thrown when the owner declined (or the gate timed out); nothing was written. */
export class ExtensionInstallNotApprovedError extends Error {
  constructor(id: string) {
    super(`ERR_EXTENSION_INSTALL_NOT_APPROVED: install of ${id} was not approved`);
    this.name = "ExtensionInstallNotApprovedError";
  }
}
