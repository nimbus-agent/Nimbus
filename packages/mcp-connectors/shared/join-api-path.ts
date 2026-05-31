export function joinApiPath(baseUrl: string, path: string): string {
  if (path.startsWith("http")) {
    return path;
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${suffix}`;
}
