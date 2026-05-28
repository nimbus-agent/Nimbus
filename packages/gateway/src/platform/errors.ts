export class PlatformInitError extends Error {
  override readonly name = "PlatformInitError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
