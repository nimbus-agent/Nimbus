/**
 * Quoting for command lines the CLI PRINTS for the user to paste. Single quotes in both shells, so
 * nothing inside is expanded: no `$`, backtick or `$(...)` substitution. Only the escape for an
 * embedded single quote differs between them.
 */

/** Inside a bash single-quoted string: close the quote, an escaped quote, reopen. */
const BASH_ESCAPED_QUOTE = String.raw`'\''`;

/** `s` as a bash/zsh single-quoted literal. */
export function bashQuote(s: string): string {
  return `'${s.replaceAll("'", BASH_ESCAPED_QUOTE)}'`;
}

/** `s` as a PowerShell single-quoted (verbatim) literal. */
export function pwshQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * `arg` for a command printed to the user of `platform`'s usual shell (PowerShell on Windows,
 * bash/zsh elsewhere). A plain token stays bare so the common case reads naturally, except one
 * starting with `@`, which PowerShell reads as splatting or an array/hash literal (`cd @work`).
 */
export function quoteForPrintedCommand(
  arg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (/^[\w./:=+-][\w./@:=+-]*$/.test(arg)) return arg;
  return platform === "win32" ? pwshQuote(arg) : bashQuote(arg);
}
