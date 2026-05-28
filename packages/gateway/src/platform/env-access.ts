export function processEnvGet(name: string): string | undefined {
  const v = process.env[name];
  return v;
}

export function processEnvDelete(name: string): void {
  Reflect.deleteProperty(process.env, name);
}

export function processEnvSet(name: string, value: string | undefined): void {
  if (value === undefined) {
    processEnvDelete(name);
    return;
  }
  process.env[name] = value;
}
