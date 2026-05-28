type Thenable<T> = PromiseLike<T>;

export interface WebviewLike {
  cspSource: string;
  asWebviewUri(localPath: string): string;
  html: string;
  postMessage(msg: unknown): Thenable<boolean>;
  onDidReceiveMessage(handler: (msg: unknown) => void): { dispose(): void };
}

export interface WebviewPanelLike {
  visible: boolean;
  active: boolean;
  webview: WebviewLike;
  reveal(): void;
  dispose(): void;
  onDidDispose(handler: () => void): { dispose(): void };
  onDidChangeViewState(handler: () => void): { dispose(): void };
}

export interface ChatPanel {
  reveal(): void;
  dispose(): void;
  panel(): WebviewPanelLike | undefined;
  onDispose(handler: () => void): void;
  onMessage(handler: (msg: unknown) => void): void;
  postMessage(msg: unknown): Thenable<boolean>;
  isVisible(): boolean;
  isActive(): boolean;
}

export interface ChatPanelFactory {
  createOrReveal(): ChatPanel;
  current(): ChatPanel | undefined;
}

export function createNoopChatPanel(): ChatPanel {
  let disposed = false;
  const disposeListeners: Array<() => void> = [];
  return {
    reveal: () => undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const l of disposeListeners) l();
    },
    panel: () => undefined,
    onDispose: (h) => {
      disposeListeners.push(h);
    },
    onMessage: () => undefined,
    postMessage: () => Promise.resolve(true),
    isVisible: () => false,
    isActive: () => false,
  };
}
