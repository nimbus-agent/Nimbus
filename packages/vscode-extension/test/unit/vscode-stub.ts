export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => undefined,
    show: (_preserveFocus?: boolean) => undefined,
    dispose: () => undefined,
  }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: "",
    backgroundColor: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
};
export const workspace = {
  getConfiguration: (_section: string) => ({
    get: (_key: string, dflt: unknown) => dflt,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
};
export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined,
};
export const env = {
  openExternal: async () => true,
  isTelemetryEnabled: false,
};
export class ThemeColor {
  constructor(public id: string) {}
}
export const Uri = {
  parse: (s: string) => ({ toString: () => s, scheme: s.split(":")[0] ?? "" }),
};
export enum ViewColumn {
  Beside = -2,
  Active = -1,
  One = 1,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
