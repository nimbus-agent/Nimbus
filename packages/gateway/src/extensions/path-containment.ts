import path from "node:path";

/**
 * True when `p` resolves to a location strictly below `root` (not `root` itself). `flavour`
 * defaults to the host's `node:path`; a test passes `path.win32` or `path.posix` to run either
 * rule on any OS.
 *
 * `path.relative` between two Windows drives returns an ABSOLUTE path (`D:\x`) that neither
 * starts with `..` nor with a separator, so the absolute check is load-bearing. On a Windows
 * flavour the comparison ignores case, as the file system does.
 */
export function isStrictlyInside(
  root: string,
  p: string,
  flavour: typeof path.posix | typeof path.win32 = path,
): boolean {
  const caseInsensitive = flavour.sep === "\\";
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
  const rel = flavour.relative(fold(flavour.resolve(root)), fold(flavour.resolve(p)));
  return (
    rel !== "" && rel !== ".." && !rel.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(rel)
  );
}
