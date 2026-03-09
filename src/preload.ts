import { contextBridge, ipcRenderer } from 'electron';

export interface ShellEntry {
  id: string;
  label: string;
  exe: string;
  isMsys2: boolean;
}

export interface ShellListResult {
  shells: ShellEntry[];
  defaultId: string;
}

export interface PtyCreateResult {
  id: number;
  shell: string;
}

export interface PtyDataEvent {
  id: number;
  data: string;
}

export interface PtyExitEvent {
  id: number;
  exitCode: number;
  signal?: number;
}

export interface SSHProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key' | 'both';
  password?: string;
  keyPath?: string;
  pinned: boolean;
  lastUsed: number;
  useCount: number;
}

const electronAPI = {
  // Platform info
  platform: process.platform as string,

  // Shell discovery and preferences
  listShells: (): Promise<ShellListResult> =>
    ipcRenderer.invoke('shell-list'),

  setDefaultShell: (id: string): void =>
    ipcRenderer.send('shell-set-default', { id }),

  // PTY lifecycle
  createPty: (opts: { shell?: string; cols: number; rows: number }): Promise<PtyCreateResult> =>
    ipcRenderer.invoke('pty-create', opts),

  killPty: (id: number): void =>
    ipcRenderer.send('pty-kill', { id }),

  // I/O
  sendInput: (id: number, data: string): void =>
    ipcRenderer.send('pty-input', { id, data }),

  resize: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send('pty-resize', { id, cols, rows }),

  resizeTmuxLeft: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send('pty-resize-tmux-left', { id, cols, rows }),

  // Events
  onData: (callback: (event: PtyDataEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: PtyDataEvent) => callback(event);
    ipcRenderer.on('pty-data', handler);
    return () => ipcRenderer.removeListener('pty-data', handler);
  },

  onExit: (callback: (event: PtyExitEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: PtyExitEvent) => callback(event);
    ipcRenderer.on('pty-exit', handler);
    return () => ipcRenderer.removeListener('pty-exit', handler);
  },

  // Window controls
  minimize: (): void => ipcRenderer.send('window-minimize'),
  maximize: (): void => ipcRenderer.send('window-maximize'),
  close: (): void => ipcRenderer.send('window-close'),
  toggleFullscreen: (): void => ipcRenderer.send('window-fullscreen-toggle'),

  // Keybindings
  getKeybindings: (): Promise<Record<string, string | string[]>> =>
    ipcRenderer.invoke('get-keybindings'),

  // Open in editor
  openInEditor: (opts: { file: string; line: number; col: number; cwd: string }): Promise<{ type: string; command?: string }> =>
    ipcRenderer.invoke('open-in-editor', opts),

  verifyFiles: (opts: { baseDir: string; candidates: string[] }): Promise<Array<{ name: string; exists: boolean; isDir: boolean; fullPath: string }>> =>
    ipcRenderer.invoke('verify-files', opts),

  getPtyCwd: (pid: number): Promise<string> =>
    ipcRenderer.invoke('get-pty-cwd', { pid }),

  // Settings
  getSettings: (): Promise<Record<string, any>> =>
    ipcRenderer.invoke('get-settings'),

  saveSettings: (settings: Record<string, any>): void =>
    ipcRenderer.send('save-settings', { settings }),

  setWindowOpacity: (opacity: number): void =>
    ipcRenderer.send('window-set-opacity', { opacity }),

  // SSH profiles
  sshProfilesList: (): Promise<SSHProfile[]> =>
    ipcRenderer.invoke('ssh-profiles-list'),

  sshProfileSave: (profile: SSHProfile): void =>
    ipcRenderer.send('ssh-profile-save', { profile }),

  sshProfileDelete: (id: string): void =>
    ipcRenderer.send('ssh-profile-delete', { id }),

  sshProfilePin: (id: string, pinned: boolean): void =>
    ipcRenderer.send('ssh-profile-pin', { id, pinned }),

  // SSH session
  sshConnect: (opts: { profile: SSHProfile; cols: number; rows: number }): Promise<{ id: number }> =>
    ipcRenderer.invoke('ssh-connect', opts),

  sshDisconnect: (id: number): void =>
    ipcRenderer.send('ssh-disconnect', { id }),

  sshResize: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send('ssh-resize', { id, cols, rows }),

  // File dialog
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog-open-file'),

  // Sharing - host
  shareStart: (opts: { tabs: Array<{ id: number; title: string; cols: number; rows: number }>; activeTabId: number }): Promise<{ port: number; code: string; ip: string; qrDataUrl: string; connectUrl: string }> =>
    ipcRenderer.invoke('share-start', opts),

  shareStop: (): void =>
    ipcRenderer.send('share-stop'),

  shareTabAdded: (tab: { id: number; title: string; cols: number; rows: number }): void =>
    ipcRenderer.send('share-tab-added', { tab }),

  shareTabRemoved: (tabId: number): void =>
    ipcRenderer.send('share-tab-removed', { tabId }),

  shareTabActivated: (tabId: number): void =>
    ipcRenderer.send('share-tab-activated', { tabId }),

  shareTabTitle: (tabId: number, title: string): void =>
    ipcRenderer.send('share-tab-title', { tabId, title }),

  shareTabResized: (tabId: number, cols: number, rows: number): void =>
    ipcRenderer.send('share-tab-resized', { tabId, cols, rows }),

  onShareClientCount: (callback: (count: number) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, count: number) => callback(count);
    ipcRenderer.on('share-client-count', handler);
    return () => ipcRenderer.removeListener('share-client-count', handler);
  },

  // Sharing - client
  shareConnect: (opts: { host: string; port: number; code: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('share-connect', opts),

  shareDisconnect: (): void =>
    ipcRenderer.send('share-disconnect'),

  shareRemoteInput: (tabId: number, data: string): void =>
    ipcRenderer.send('share-remote-input', { tabId, data }),

  onShareRemoteMessage: (callback: (msg: any) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, msg: any) => callback(msg);
    ipcRenderer.on('share-remote-message', handler);
    return () => ipcRenderer.removeListener('share-remote-message', handler);
  },

  onShareRemoteDisconnected: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('share-remote-disconnected', handler);
    return () => ipcRenderer.removeListener('share-remote-disconnected', handler);
  },

  // Web Terminal (ttyd)
  webTerminalStart: (opts?: { port?: number }): Promise<{ port: number; username: string; password: string; localUrl: string; tailscaleUrl: string | null; qrDataUrl: string }> =>
    ipcRenderer.invoke('web-terminal-start', opts ?? {}),

  webTerminalStop: (): void =>
    ipcRenderer.send('web-terminal-stop'),

  onWebTerminalStopped: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('web-terminal-stopped', handler);
    return () => ipcRenderer.removeListener('web-terminal-stopped', handler);
  },

  onWebTerminalError: (callback: (msg: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, msg: string) => callback(msg);
    ipcRenderer.on('web-terminal-error', handler);
    return () => ipcRenderer.removeListener('web-terminal-error', handler);
  },

  // Graceful restart (preserves web terminal connection)
  gracefulRestart: (): Promise<void> =>
    ipcRenderer.invoke('graceful-restart'),

  onWebTerminalRestored: (callback: (info: { port: number; username: string; password: string; localUrl: string; tailscaleUrl: string | null }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('web-terminal-restored', handler);
    return () => ipcRenderer.removeListener('web-terminal-restored', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
