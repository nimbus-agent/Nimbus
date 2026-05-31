type Thenable<T> = PromiseLike<T>;

export interface DisposableLike {
  dispose(): void;
}

export interface OutputChannelHandle {
  appendLine(msg: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface StatusBarItemHandle {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: { id: string } | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface QuickPickItemLike {
  label: string;
  description?: string;
  detail?: string;
}

export interface TextEditorLike {
  document: { getText(range?: unknown): string };
  selection: { isEmpty: boolean };
}

export interface WindowApi {
  createOutputChannel(name: string): OutputChannelHandle;
  createStatusBarItem(alignment: 1 | 2, priority: number): StatusBarItemHandle;
  showInformationMessage(
    msg: string,
    opts: { modal?: boolean },
    ...items: string[]
  ): Thenable<string | undefined>;
  showErrorMessage(msg: string, ...items: string[]): Thenable<string | undefined>;
  showInputBox(opts?: { prompt?: string; value?: string }): Thenable<string | undefined>;
  showQuickPick<T extends QuickPickItemLike>(
    items: readonly T[],
    opts?: { placeHolder?: string; matchOnDescription?: boolean; matchOnDetail?: boolean },
  ): Thenable<T | undefined>;
  activeTextEditor: TextEditorLike | undefined;
}

export interface WorkspaceConfigSection {
  get<T>(key: string, defaultValue: T): T;
}

export interface ConfigurationChangeEventLike {
  affectsConfiguration(section: string): boolean;
}

export interface WorkspaceApi {
  getConfiguration(section: string): WorkspaceConfigSection;
  onDidChangeConfiguration(handler: (e: ConfigurationChangeEventLike) => void): DisposableLike;
}

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface CommandsApi {
  executeCommand<T>(command: string, ...args: unknown[]): Thenable<T | undefined>;
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): DisposableLike;
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[];
  workspaceState: MementoLike;
}
