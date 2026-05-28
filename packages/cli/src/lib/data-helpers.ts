export function parseScriptConsentSource(args: string[]): string | undefined {
  const idx = args.indexOf("--script-consent-source");
  if (idx >= 0) {
    const path = args[idx + 1];
    if (path === undefined || path.startsWith("--")) {
      throw new Error("--script-consent-source requires a file path argument");
    }
    return path;
  }
  const env = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
  return env !== undefined && env.length > 0 ? env : undefined;
}

export function assertDestructiveDeleteAllowed(opts: {
  yes: boolean;
  scriptConsentSource: string | undefined;
}): void {
  if (!opts.yes && opts.scriptConsentSource === undefined) {
    throw new Error(
      "Pass --yes (or --script-consent-source for cast-driver) to confirm destructive deletion (non-interactive CLI)",
    );
  }
}
