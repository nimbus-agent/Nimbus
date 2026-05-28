export function envGet(name: string): string | undefined {
  return process.env[name];
}
