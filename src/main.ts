import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { Client as SSHClient, ConnectConfig } from 'ssh2';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { StringDecoder } from 'string_decoder';
import { spawn, execFileSync } from 'child_process';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SharingServer, SharingClient, SharedTabInfo } from './sharing';
import * as QRCode from 'qrcode';

// macOS: Chromium compositor の elastic overscroll を無効化 (app.ready より前に設定)
app.commandLine.appendSwitch('disable-features', 'ElasticOverscroll');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');

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

let mainWindow: BrowserWindow | null = null;
const ptyProcesses = new Map<number, pty.IPty>();
const sshSessions = new Map<number, { conn: SSHClient; stream: NodeJS.ReadWriteStream }>();
let nextPtyId = 1;
let sharingServer: SharingServer | null = null;
let sharingClient: SharingClient | null = null;
let webTerminalServer: http.Server | null = null;
let webTerminalWss: WebSocketServer | null = null;
let webTerminalPty: pty.IPty | null = null;
let webTerminalPassword: string | null = null;
let webTerminalPort: number | null = null;

// ---- Graceful restart state persistence ----

const RESTART_STATE_FILE = path.join(os.tmpdir(), 'infiniterm-restart-state.json');

interface RestartState {
  webTerminal?: { password: string; port: number };
  timestamp: number;
}

function saveRestartState(): void {
  const state: RestartState = { timestamp: Date.now() };
  if (webTerminalServer && webTerminalPassword && webTerminalPort) {
    state.webTerminal = { password: webTerminalPassword, port: webTerminalPort };
  }
  try {
    fs.writeFileSync(RESTART_STATE_FILE, JSON.stringify(state), 'utf8');
  } catch { /* ignore */ }
}

function loadAndClearRestartState(): RestartState | null {
  try {
    const data = fs.readFileSync(RESTART_STATE_FILE, 'utf8');
    fs.unlinkSync(RESTART_STATE_FILE);
    const state = JSON.parse(data) as RestartState;
    // Ignore stale state (older than 30 seconds)
    if (Date.now() - state.timestamp > 30000) return null;
    return state;
  } catch {
    return null;
  }
}

// ---- Platform detection ----

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ---- Windows CWD detection ----

/** Find the deepest descendant process (the actual shell/command) of a PTY process. */
function getLeafChildPid(pid: number): number {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p=${pid}; while($true){$c=Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -EA SilentlyContinue | Select -First 1; if(!$c){break}; $p=$c.ProcessId}; $p`
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    const childPid = parseInt(out, 10);
    return (childPid && childPid !== pid) ? childPid : pid;
  } catch { return pid; }
}

/**
 * Read the CWD of a Windows process by querying its PEB (Process Environment Block)
 * via PowerShell P/Invoke. Falls back to home directory on failure.
 */
function getWindowsCwd(pid: number): string {
  const targetPid = getLeafChildPid(pid);
  try {
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ProcCwd {
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h,int c,ref PBI i,int s,out int r);
  [DllImport("kernel32.dll")]
  static extern IntPtr OpenProcess(int a,bool b,int p);
  [DllImport("kernel32.dll")]
  static extern bool ReadProcessMemory(IntPtr h,IntPtr ba,byte[] bu,int s,out int r);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)]
  struct PBI {public IntPtr R1;public IntPtr PebBaseAddress;public IntPtr R2a;public IntPtr R2b;public IntPtr Uid;public IntPtr R3;}
  public static string Get(int pid){
    IntPtr hp=OpenProcess(0x0410,false,pid);
    if(hp==IntPtr.Zero)return "";
    try{
      var pbi=new PBI();int rl;
      NtQueryInformationProcess(hp,0,ref pbi,Marshal.SizeOf(pbi),out rl);
      int ps=IntPtr.Size;
      byte[] b=new byte[ps];
      int ppOff=ps==8?0x20:0x10;
      ReadProcessMemory(hp,pbi.PebBaseAddress+ppOff,b,ps,out rl);
      IntPtr pp=ps==8?(IntPtr)BitConverter.ToInt64(b,0):(IntPtr)BitConverter.ToInt32(b,0);
      int cdOff=ps==8?0x38:0x24;
      byte[] us=new byte[ps+4];
      ReadProcessMemory(hp,pp+cdOff,us,us.Length,out rl);
      short len=BitConverter.ToInt16(us,0);
      IntPtr sp=ps==8?(IntPtr)BitConverter.ToInt64(us,4):(IntPtr)BitConverter.ToInt32(us,4);
      byte[] sb=new byte[len];
      ReadProcessMemory(hp,sp,sb,len,out rl);
      string r=System.Text.Encoding.Unicode.GetString(sb);
      return r.TrimEnd(new char[]{'\\\\'});
    }finally{CloseHandle(hp);}
  }
}
"@
[ProcCwd]::Get(${targetPid})
`.trim();
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch { /* fall through */ }

  // Fallback: return home directory
  return os.homedir();
}

// ---- MSYS2 detection (Windows only) ----

function getMsys2SearchRoots(): string[] {
  const roots: string[] = [];
  const envRoot = process.env.MSYS2_ROOT ?? process.env.MSYS_ROOT;
  if (envRoot) roots.push(envRoot.replace(/[/\\]$/, ''));
  const sysDrive = (process.env.SYSTEMDRIVE ?? 'C:').replace(/[/\\]$/, '');
  roots.push(path.join(sysDrive, 'msys64'), path.join(sysDrive, 'msys32'));
  for (const letter of ['C', 'D', 'E']) {
    if (!sysDrive.toUpperCase().startsWith(letter)) {
      roots.push(`${letter}:\\msys64`, `${letter}:\\msys32`);
    }
  }
  return roots;
}

interface Msys2Info {
  root: string;
  zsh: string;
  bash: string;
}

function findMsys2(): Msys2Info | null {
  if (!isWin) return null;
  for (const root of getMsys2SearchRoots()) {
    const zsh = path.join(root, 'usr', 'bin', 'zsh.exe');
    const bash = path.join(root, 'usr', 'bin', 'bash.exe');
    if (fs.existsSync(zsh)) {
      return { root, zsh, bash };
    }
  }
  return null;
}

function buildMsys2Env(root: string): { [key: string]: string } {
  const msys2BinPaths = [
    path.join(root, 'usr', 'local', 'bin'),
    path.join(root, 'usr', 'bin'),
    path.join(root, 'bin'),
  ];

  const msys2PosixPaths = [
    '/usr/local/bin', '/usr/bin', '/bin',
    '/usr/bin/site_perl', '/usr/bin/vendor_perl', '/usr/bin/core_perl',
  ].join(':');

  const winPath = process.env.PATH ?? '';
  const combinedPath = [...msys2BinPaths, winPath].join(';');

  return {
    ...process.env as { [key: string]: string },
    MSYSTEM: 'MSYS',
    PATH: combinedPath,
    MSYS2_PATH: msys2PosixPaths,
    CHERE_INVOKING: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'infiniterm',
    TERM_PROGRAM_VERSION: '0.1.0',
    LANG: 'ja_JP.UTF-8',
    LC_ALL: 'ja_JP.UTF-8',
    MSYS: 'winsymlinks:nativestrict',
    NCURSES_NO_UTF8_ACS: '1',
  };
}

// ---- Git Bash detection (Windows only) ----

interface GitBashInfo {
  root: string;
  bash: string;
}

function findGitBash(): GitBashInfo | null {
  if (!isWin) return null;
  const candidates: string[] = [];

  // Check PATH first (where.exe)
  try {
    const result = execFileSync('where.exe', ['git.exe'], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
    const gitExe = result.trim().split(/\r?\n/)[0];
    if (gitExe) {
      // git.exe is typically in <root>/cmd/git.exe or <root>/bin/git.exe
      const gitDir = path.dirname(gitExe);
      const root = path.dirname(gitDir);
      candidates.push(root);
    }
  } catch { /* git not in PATH */ }

  // Standard install locations
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  candidates.push(path.join(programFiles, 'Git'));
  candidates.push(path.join(programFilesX86, 'Git'));
  const sysDrive = (process.env.SYSTEMDRIVE ?? 'C:').replace(/[/\\]$/, '');
  candidates.push(path.join(sysDrive, 'Git'));

  for (const root of candidates) {
    const bash = path.join(root, 'bin', 'bash.exe');
    if (fs.existsSync(bash)) {
      // Skip if this is actually the MSYS2 root (avoid duplicates)
      const msys2 = findMsys2();
      if (msys2 && root.toLowerCase() === msys2.root.toLowerCase()) continue;
      return { root, bash };
    }
  }
  return null;
}

function buildGitBashEnv(root: string): { [key: string]: string } {
  const gitBinPaths = [
    path.join(root, 'usr', 'bin'),
    path.join(root, 'bin'),
    path.join(root, 'mingw64', 'bin'),
  ];

  const winPath = process.env.PATH ?? '';
  const combinedPath = [...gitBinPaths, winPath].join(';');

  return {
    ...process.env as { [key: string]: string },
    PATH: combinedPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'infiniterm',
    TERM_PROGRAM_VERSION: '0.1.0',
    LANG: 'ja_JP.UTF-8',
  };
}

function buildBaseEnv(): { [key: string]: string } {
  return {
    ...process.env as { [key: string]: string },
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'infiniterm',
    TERM_PROGRAM_VERSION: '0.1.0',
  };
}

// ---- Shell catalog ----

export interface ShellEntry {
  id: string;
  label: string;
  exe: string;
  isMsys2: boolean;
}

function detectShells(): ShellEntry[] {
  if (isWin) return detectShellsWindows();
  return detectShellsUnix();
}

function detectShellsWindows(): ShellEntry[] {
  const shells: ShellEntry[] = [];

  // 1. MSYS2 zsh
  const msys2 = findMsys2();
  if (msys2) {
    shells.push({ id: 'msys2-zsh', label: 'zsh (MSYS2)', exe: msys2.zsh, isMsys2: true });
    if (fs.existsSync(msys2.bash)) {
      shells.push({ id: 'msys2-bash', label: 'bash (MSYS2)', exe: msys2.bash, isMsys2: true });
    }
  }

  // 2. PowerShell 7 (pwsh)
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  for (const p of [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
  ]) {
    if (fs.existsSync(p)) {
      shells.push({ id: 'pwsh7', label: 'PowerShell 7 (pwsh)', exe: p, isMsys2: false });
      break;
    }
  }

  // 3. PowerShell 5
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const ps5 = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(ps5)) {
    shells.push({ id: 'pwsh5', label: 'PowerShell 5', exe: ps5, isMsys2: false });
  }

  // 4. Git Bash
  const gitBash = findGitBash();
  if (gitBash) {
    shells.push({ id: 'git-bash', label: 'Git Bash', exe: gitBash.bash, isMsys2: false });
  }

  // 5. CMD
  const cmd = process.env.COMSPEC ?? path.join(systemRoot, 'System32', 'cmd.exe');
  if (fs.existsSync(cmd)) {
    shells.push({ id: 'cmd', label: 'Command Prompt', exe: cmd, isMsys2: false });
  }

  return shells;
}

function detectShellsUnix(): ShellEntry[] {
  const shells: ShellEntry[] = [];
  const seen = new Set<string>();

  const candidates: { id: string; label: string; paths: string[] }[] = [
    { id: 'zsh',  label: 'zsh',  paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'] },
    { id: 'bash', label: 'bash', paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'] },
    { id: 'fish', label: 'fish', paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'] },
    { id: 'sh',   label: 'sh',   paths: ['/bin/sh'] },
  ];

  for (const c of candidates) {
    for (const p of c.paths) {
      if (!seen.has(c.id) && fs.existsSync(p)) {
        shells.push({ id: c.id, label: c.label, exe: p, isMsys2: false });
        seen.add(c.id);
        break;
      }
    }
  }

  return shells;
}

// ---- Preferences (default shell) ----

const PREFS_FILE = path.join(os.homedir(), '.infiniterm.json');

interface Prefs {
  defaultShellId: string;
  sshProfiles: SSHProfile[];
  keybindings?: Record<string, string | string[]>;
  editor?: string;
  settings?: Record<string, any>;
}

function loadPrefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) as Prefs;
  } catch {
    return { defaultShellId: '', sshProfiles: [] };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// ---- PTY env resolver ----

function resolveShellEnv(exe: string): { [key: string]: string } {
  const msys2 = findMsys2();
  if (msys2 && exe.toLowerCase().startsWith(msys2.root.toLowerCase())) {
    return buildMsys2Env(msys2.root);
  }
  const gitBash = findGitBash();
  if (gitBash && exe.toLowerCase().startsWith(gitBash.root.toLowerCase())) {
    return buildGitBashEnv(gitBash.root);
  }
  return buildBaseEnv();
}

// ---- Editor detection ----

function detectEditor(): string {
  const prefs = loadPrefs();
  if (prefs.editor && prefs.editor !== 'auto') return prefs.editor;

  if (process.env.VISUAL) return process.env.VISUAL;
  if (process.env.EDITOR) return process.env.EDITOR;

  const candidates = isMac
    ? ['code', 'cursor', 'emacsclient', 'emacs', 'vim', 'nvim']
    : ['code', 'cursor', 'emacs', 'vim', 'nvim'];
  const which = isWin ? 'where.exe' : 'which';
  for (const cmd of candidates) {
    try {
      execFileSync(which, [cmd], { stdio: 'ignore' });
      return cmd;
    } catch { /* not found */ }
  }
  return 'vim';
}

function buildEditorCommand(editor: string, file: string, line: number, col: number): { cmd: string; args: string[]; isGui: boolean } {
  const basename = path.basename(editor).replace(/\.exe$/i, '').toLowerCase();

  if (basename === 'code' || basename === 'cursor') {
    return { cmd: editor, args: ['-g', `${file}:${line}:${col}`], isGui: true };
  }
  if (basename === 'emacsclient') {
    return { cmd: editor, args: ['-n', `+${line}:${col}`, file], isGui: true };
  }
  if (basename === 'emacs') {
    return { cmd: editor, args: [`+${line}:${col}`, file], isGui: true };
  }
  if (basename === 'subl' || basename === 'sublime_text') {
    return { cmd: editor, args: [`${file}:${line}:${col}`], isGui: true };
  }
  // Terminal editors: vim, nvim, nano, etc.
  if (basename === 'vim' || basename === 'nvim' || basename === 'vi') {
    return { cmd: editor, args: [`+${line}`, file], isGui: false };
  }
  return { cmd: editor, args: [file], isGui: false };
}

// ---- Window ----

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    frame: isWin ? false : true,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 10, y: 6 } : undefined,
    show: false,
    title: 'infiniterm',
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    for (const ptyProc of ptyProcesses.values()) {
      try { ptyProc.kill(); } catch (_) { /* ignore */ }
    }
    ptyProcesses.clear();
    for (const ssh of sshSessions.values()) {
      try { ssh.conn.end(); } catch (_) { /* ignore */ }
    }
    sshSessions.clear();
    if (webTerminalPty) { try { webTerminalPty.kill(); } catch {} webTerminalPty = null; }
    if (webTerminalWss) { try { webTerminalWss.close(); } catch {} webTerminalWss = null; }
    if (webTerminalServer) { try { webTerminalServer.close(); } catch {} webTerminalServer = null; }
    sharingServer?.stop();
    mainWindow = null;
  });
}

// ---- IPC ----

app.whenReady().then(() => {
  createWindow();

  // List available shells
  ipcMain.handle('shell-list', () => {
    const shells = detectShells();
    const prefs = loadPrefs();
    const defaultId = prefs.defaultShellId || (shells[0]?.id ?? '');
    return { shells, defaultId };
  });

  // Set default shell
  ipcMain.on('shell-set-default', (_event, { id }: { id: string }) => {
    const prefs = loadPrefs();
    prefs.defaultShellId = id;
    savePrefs(prefs);
  });

  // Create PTY
  ipcMain.handle('pty-create', (_event, { shell: shellExe, cols, rows }: {
    shell?: string;
    cols: number;
    rows: number;
  }) => {
    const id = nextPtyId++;

    let exe: string;
    if (shellExe) {
      exe = shellExe;
    } else {
      // Use saved default or first detected shell
      const shells = detectShells();
      const prefs = loadPrefs();
      const found = shells.find(s => s.id === prefs.defaultShellId) ?? shells[0];
      if (isWin) {
        exe = found?.exe ?? (process.env.COMSPEC ?? 'cmd.exe');
      } else {
        exe = found?.exe ?? (process.env.SHELL ?? '/bin/zsh');
      }
    }

    const env = resolveShellEnv(exe);

    let spawnExe: string;
    let spawnArgs: string[];

    if (isWin) {
      // MSYS2 / Git Bash シェルは cmd.exe 経由で起動し、先に chcp 65001 (UTF-8) を設定する。
      const msys2 = findMsys2();
      const gitBash = findGitBash();
      const isMsys2Shell = !!(msys2 && exe.toLowerCase().startsWith(msys2.root.toLowerCase()));
      const isGitBashShell = !!(gitBash && exe.toLowerCase().startsWith(gitBash.root.toLowerCase()));

      if (isMsys2Shell || isGitBashShell) {
        const comspec = process.env.COMSPEC ?? 'cmd.exe';
        spawnExe = comspec;
        spawnArgs = ['/c', `chcp 65001>nul 2>&1 & ${exe}`];
      } else {
        spawnExe = exe;
        spawnArgs = [];
      }
    } else {
      // macOS / Linux
      spawnExe = exe;
      spawnArgs = [];
    }

    const ptyProc = pty.spawn(spawnExe, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env,
      ...(isWin ? { useConpty: true, conptyInheritCursor: false } : {}),
    });

    ptyProc.onData((data: string) => {
      // On Windows, ConPTY emits spurious escape sequences that cause visual
      // artefacts (e.g. flickering, ghost characters). Strip the most common
      // offenders:
      //   - CSI ?25l / ?25h  hide/show cursor pairs emitted around every
      //     redraw (causes cursor flicker)
      //   - CSI ?12l / ?12h  stop/start cursor blink
      const cleaned = isWin
        ? data.replace(/\x1b\[\?(?:12|25)[hl]/g, '')
        : data;
      mainWindow?.webContents.send('pty-data', { id, data: cleaned });
      sharingServer?.feedData(id, cleaned);
    });

    ptyProc.onExit(({ exitCode, signal }) => {
      mainWindow?.webContents.send('pty-exit', { id, exitCode, signal });
      ptyProcesses.delete(id);
      sharingServer?.removeTab(id);
    });

    ptyProcesses.set(id, ptyProc);
    return { id, shell: exe, pid: ptyProc.pid, cwd: os.homedir() };
  });

  // Input
  ipcMain.on('pty-input', (_event, { id, data }: { id: number; data: string }) => {
    const ptyProc = ptyProcesses.get(id);
    if (ptyProc) {
      try { ptyProc.write(data); } catch (_) { /* ignore */ }
      return;
    }
    const ssh = sshSessions.get(id);
    if (ssh) {
      try { ssh.stream.write(data); } catch (_) { /* ignore */ }
    }
  });

  // Resize — debounce on Windows to prevent ConPTY instability during rapid resizes
  const resizeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  ipcMain.on('pty-resize', (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
    const ptyProc = ptyProcesses.get(id);
    if (!ptyProc) return;
    const safeCols = Math.max(1, cols);
    const safeRows = Math.max(1, rows);
    if (isWin) {
      // Debounce ConPTY resizes to avoid flickering and garbled output
      const existing = resizeTimers.get(id);
      if (existing) clearTimeout(existing);
      resizeTimers.set(id, setTimeout(() => {
        resizeTimers.delete(id);
        try { ptyProc.resize(safeCols, safeRows); } catch (_) { /* ignore */ }
      }, 80));
    } else {
      try { ptyProc.resize(safeCols, safeRows); } catch (_) { /* ignore */ }
    }
  });

  // Resize with tmux left-pane expansion mode
  // 1. Query current tmux pane widths before resize
  // 2. Resize the PTY (tmux redistributes equally)
  // 3. Restore non-leftmost pane widths so leftmost pane gets all extra space
  ipcMain.on('pty-resize-tmux-left', (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
    const ptyProc = ptyProcesses.get(id);
    if (!ptyProc) return;

    // Find tmux session associated with this PTY
    let tmuxTarget: string | null = null;
    try {
      let ptsTty: string;
      if (process.platform === 'linux') {
        ptsTty = fs.readlinkSync(`/proc/${ptyProc.pid}/fd/0`);
      } else {
        // macOS: ps -p <pid> -o tty= returns e.g. "ttys001"
        const ttyRaw = execFileSync('ps', ['-p', String(ptyProc.pid), '-o', 'tty='], {
          encoding: 'utf8', timeout: 1000,
        }).trim();
        ptsTty = `/dev/${ttyRaw}`;
      }
      const clients = execFileSync('tmux', ['list-clients', '-F', '#{client_tty} #{session_name}'], {
        encoding: 'utf8', timeout: 1000,
      }).trim();
      for (const line of clients.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 0) continue;
        const tty = line.substring(0, spaceIdx);
        const session = line.substring(spaceIdx + 1);
        if (tty === ptsTty) { tmuxTarget = session; break; }
      }
    } catch { /* tmux not available or not running */ }

    // Query current pane widths before resize
    interface PaneInfo { paneId: string; width: number; left: number; }
    let nonLeftPanes: PaneInfo[] = [];
    if (tmuxTarget !== null) {
      try {
        const output = execFileSync('tmux', [
          'list-panes', '-t', tmuxTarget,
          '-F', '#{pane_id} #{pane_width} #{pane_left}',
        ], { encoding: 'utf8', timeout: 1000 }).trim();
        const panes = output.split('\n').map(line => {
          const [paneId, w, l] = line.split(' ');
          return { paneId, width: parseInt(w), left: parseInt(l) };
        });
        nonLeftPanes = panes.filter(p => p.left > 0);
      } catch { /* ignore */ }
    }

    // Resize the PTY
    try { ptyProc.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* ignore */ }

    // After tmux processes the resize, restore non-leftmost pane widths
    if (nonLeftPanes.length > 0) {
      setTimeout(() => {
        for (const pane of nonLeftPanes) {
          try {
            execFileSync('tmux', ['resize-pane', '-t', pane.paneId, '-x', String(pane.width)], {
              timeout: 1000,
            });
          } catch { /* ignore */ }
        }
      }, 50);
    }
  });

  // Kill
  ipcMain.on('pty-kill', (_event, { id }: { id: number }) => {
    const ptyProc = ptyProcesses.get(id);
    if (ptyProc) {
      try { ptyProc.kill(); } catch (_) { /* ignore */ }
      ptyProcesses.delete(id);
    }
  });

  // SSH profile list
  ipcMain.handle('ssh-profiles-list', () => {
    return loadPrefs().sshProfiles;
  });

  // SSH profile save (upsert)
  ipcMain.on('ssh-profile-save', (_event, { profile }: { profile: SSHProfile }) => {
    const prefs = loadPrefs();
    const idx = prefs.sshProfiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) prefs.sshProfiles[idx] = profile;
    else prefs.sshProfiles.push(profile);
    savePrefs(prefs);
  });

  // SSH profile delete
  ipcMain.on('ssh-profile-delete', (_event, { id }: { id: string }) => {
    const prefs = loadPrefs();
    prefs.sshProfiles = prefs.sshProfiles.filter(p => p.id !== id);
    savePrefs(prefs);
  });

  // SSH profile pin
  ipcMain.on('ssh-profile-pin', (_event, { id, pinned }: { id: string; pinned: boolean }) => {
    const prefs = loadPrefs();
    const p = prefs.sshProfiles.find(p => p.id === id);
    if (p) { p.pinned = pinned; savePrefs(prefs); }
  });

  // SSH connect
  ipcMain.handle('ssh-connect', (_event, {
    profile, cols, rows
  }: { profile: SSHProfile; cols: number; rows: number }) => {
    return new Promise<{ id: number }>((resolve, reject) => {
      const conn = new SSHClient();
      const id = nextPtyId++;

      const cfg: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };

      if (profile.authType === 'password') {
        cfg.password = profile.password;
      } else if (profile.authType === 'key') {
        if (profile.keyPath) {
          try { cfg.privateKey = fs.readFileSync(profile.keyPath); } catch (e) {
            return reject(new Error(`鍵ファイルを読み込めません: ${e}`));
          }
        }
        if (profile.password) cfg.passphrase = profile.password;
      } else if (profile.authType === 'both') {
        cfg.password = profile.password;
        if (profile.keyPath) {
          try { cfg.privateKey = fs.readFileSync(profile.keyPath); } catch (e) {
            return reject(new Error(`鍵ファイルを読み込めません: ${e}`));
          }
        }
      }

      conn.on('ready', () => {
        conn.shell({
          term: 'xterm-256color', cols, rows,
          modes: {
            VERASE: 127,  // Backspace = DEL (0x7f)
            ICRNL: 1,     // Map CR to NL on input
            ONLCR: 1,     // Map NL to CR+NL on output
            ISIG: 1,      // Generate signals (Ctrl+C etc.)
            ICANON: 1,    // Canonical input processing
            ECHO: 1,      // Echo input characters
            ECHOE: 1,     // Echo erase character
          },
        }, (err, stream) => {
          if (err) { conn.end(); return reject(err); }

          sshSessions.set(id, { conn, stream });
          resolve({ id });

          const decoder = new StringDecoder('utf8');
          stream.on('data', (data: Buffer) => {
            const decoded = decoder.write(data);
            mainWindow?.webContents.send('pty-data', { id, data: decoded });
            sharingServer?.feedData(id, decoded);
          });
          stream.stderr?.on('data', (data: Buffer) => {
            const decoded = decoder.write(data);
            mainWindow?.webContents.send('pty-data', { id, data: decoded });
            sharingServer?.feedData(id, decoded);
          });
          stream.on('close', () => {
            mainWindow?.webContents.send('pty-exit', { id, exitCode: 0 });
            sshSessions.delete(id);
            sharingServer?.removeTab(id);
            conn.end();
          });
        });
      });

      conn.on('error', (err) => {
        reject(new Error(err.message));
      });

      conn.connect(cfg);
    });
  });

  // SSH disconnect
  ipcMain.on('ssh-disconnect', (_event, { id }: { id: number }) => {
    const ssh = sshSessions.get(id);
    if (ssh) {
      try { ssh.conn.end(); } catch (_) { /* ignore */ }
      sshSessions.delete(id);
    }
  });

  // SSH resize
  ipcMain.on('ssh-resize', (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
    const ssh = sshSessions.get(id);
    if (ssh) {
      try { (ssh.stream as any).setWindow(rows, cols, 0, 0); } catch (_) { /* ignore */ }
    }
  });

  // Dialog: open file (for key selection)
  ipcMain.handle('dialog-open-file', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '秘密鍵ファイルを選択',
      properties: ['openFile'],
      filters: [
        { name: '秘密鍵', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519', 'openssh'] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.on('window-close', () => mainWindow?.close());
  ipcMain.on('window-fullscreen-toggle', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  // Keybindings
  ipcMain.handle('get-keybindings', () => {
    return loadPrefs().keybindings ?? {};
  });

  // Settings
  ipcMain.handle('get-settings', () => {
    return loadPrefs().settings ?? {};
  });

  ipcMain.on('save-settings', (_event, { settings }: { settings: Record<string, any> }) => {
    const prefs = loadPrefs();
    prefs.settings = settings;
    // Also sync editor preference
    if (settings.editor) prefs.editor = settings.editor;
    savePrefs(prefs);
  });

  ipcMain.on('window-set-opacity', (_event, { opacity }: { opacity: number }) => {
    if (mainWindow) mainWindow.setOpacity(Math.max(0.3, Math.min(1, opacity)));
  });

  // Open file in editor
  ipcMain.handle('open-in-editor', (_event, { file, line, col, cwd }: {
    file: string; line: number; col: number; cwd: string;
  }) => {
    // Resolve relative paths
    const resolvedFile = path.isAbsolute(file) ? file : path.resolve(cwd || os.homedir(), file);
    const editor = detectEditor();
    const { cmd, args, isGui } = buildEditorCommand(editor, resolvedFile, line, col);

    if (isGui) {
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      return { type: 'spawned' };
    }
    // Terminal editor - return command for renderer to send to PTY
    return { type: 'command', command: `${cmd} ${args.join(' ')}` };
  });

  // Get PTY process CWD from OS
  ipcMain.handle('get-pty-cwd', (_event, { pid }: { pid: number }) => {
    try {
      if (isMac) {
        const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'],
          { encoding: 'utf8', timeout: 3000 });
        const match = out.match(/\nn(.*)/);
        return match ? match[1] : '';
      } else if (isWin) {
        return getWindowsCwd(pid);
      } else {
        return fs.readlinkSync(`/proc/${pid}/cwd`);
      }
    } catch { return ''; }
  });

  // Verify file existence
  ipcMain.handle('verify-files', (_event, { baseDir, candidates }: {
    baseDir: string; candidates: string[];
  }) => {
    return candidates.map(name => {
      const fullPath = path.isAbsolute(name) ? name : path.join(baseDir, name);
      try {
        const stat = fs.statSync(fullPath);
        return { name, exists: true, isDir: stat.isDirectory(), fullPath };
      } catch {
        return { name, exists: false, isDir: false, fullPath };
      }
    });
  });

  // ---- Sharing ----

  // Start sharing server
  ipcMain.handle('share-start', async (_event, { tabs, activeTabId }: {
    tabs: SharedTabInfo[];
    activeTabId: number;
  }) => {
    if (sharingServer) sharingServer.stop();

    sharingServer = new SharingServer();

    sharingServer.on('remote-input', (tabId: number, data: string) => {
      const ptyProc = ptyProcesses.get(tabId);
      if (ptyProc) {
        try { ptyProc.write(data); } catch {}
        return;
      }
      const ssh = sshSessions.get(tabId);
      if (ssh) {
        try { ssh.stream.write(data); } catch {}
      }
    });

    sharingServer.on('client-connected', () => {
      mainWindow?.webContents.send('share-client-count', sharingServer?.getClientCount() ?? 0);
    });
    sharingServer.on('client-disconnected', () => {
      mainWindow?.webContents.send('share-client-count', sharingServer?.getClientCount() ?? 0);
    });

    const info = await sharingServer.start();

    // Register existing tabs
    for (const tab of tabs) {
      sharingServer.addTab(tab);
    }
    sharingServer.setActiveTab(activeTabId);

    // Generate QR code
    const connectUrl = `infiniterm://${info.ip}:${info.port}/${info.code}`;
    const qrDataUrl = await QRCode.toDataURL(connectUrl, { width: 200, margin: 2 });

    return { ...info, qrDataUrl, connectUrl };
  });

  // Stop sharing
  ipcMain.on('share-stop', () => {
    sharingServer?.stop();
    sharingServer = null;
  });

  // Notify sharing server of tab events from renderer
  ipcMain.on('share-tab-added', (_event, { tab }: { tab: SharedTabInfo }) => {
    sharingServer?.addTab(tab);
  });

  ipcMain.on('share-tab-removed', (_event, { tabId }: { tabId: number }) => {
    sharingServer?.removeTab(tabId);
  });

  ipcMain.on('share-tab-activated', (_event, { tabId }: { tabId: number }) => {
    sharingServer?.setActiveTab(tabId);
  });

  ipcMain.on('share-tab-title', (_event, { tabId, title }: { tabId: number; title: string }) => {
    sharingServer?.setTabTitle(tabId, title);
  });

  ipcMain.on('share-tab-resized', (_event, { tabId, cols, rows }: { tabId: number; cols: number; rows: number }) => {
    sharingServer?.resizeTab(tabId, cols, rows);
  });

  // Connect to remote host as client
  ipcMain.handle('share-connect', async (_event, { host, port, code }: {
    host: string; port: number; code: string;
  }) => {
    if (sharingClient) sharingClient.disconnect();

    sharingClient = new SharingClient();

    sharingClient.on('message', (msg: any) => {
      mainWindow?.webContents.send('share-remote-message', msg);
    });

    sharingClient.on('disconnected', () => {
      mainWindow?.webContents.send('share-remote-disconnected');
      sharingClient = null;
    });

    await sharingClient.connect(host, port, code);
    return { ok: true };
  });

  // Disconnect from remote
  ipcMain.on('share-disconnect', () => {
    sharingClient?.disconnect();
    sharingClient = null;
  });

  // Send input to remote host
  ipcMain.on('share-remote-input', (_event, { tabId, data }: { tabId: number; data: string }) => {
    sharingClient?.sendInput(tabId, data);
  });

  // ---- Web Terminal (built-in server) ----

  function getNetworkIPs(): { local: string; tailscale: string | null } {
    const interfaces = os.networkInterfaces();
    let local = '127.0.0.1';
    let tailscale: string | null = null;
    for (const addrs of Object.values(interfaces)) {
      for (const addr of addrs!) {
        if (addr.family === 'IPv4' && !addr.internal) {
          if (addr.address.startsWith('100.')) {
            tailscale = addr.address;
          } else if (local === '127.0.0.1') {
            local = addr.address;
          }
        }
      }
    }
    return { local, tailscale };
  }

  function stopWebTerminal(): void {
    if (webTerminalPty) { try { webTerminalPty.kill(); } catch {} webTerminalPty = null; }
    for (const client of webTerminalWss?.clients ?? []) {
      try { client.close(); } catch {}
    }
    if (webTerminalWss) { try { webTerminalWss.close(); } catch {} webTerminalWss = null; }
    if (webTerminalServer) { try { webTerminalServer.close(); } catch {} webTerminalServer = null; }
  }

  // Shared web terminal startup logic
  async function startWebTerminalServer(port: number, password: string): Promise<{ port: number; username: string; password: string; localUrl: string; tailscaleUrl: string | null }> {
    stopWebTerminal();

    const shells = detectShells();
    const prefs = loadPrefs();
    const found = shells.find(s => s.id === prefs.defaultShellId) ?? shells[0];
    const shellExe = found?.exe ?? (isWin
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (isMac ? '/bin/zsh' : (process.env.SHELL ?? '/bin/bash')));

    webTerminalPassword = password;
    webTerminalPort = port;

    const htmlPath = path.join(__dirname, '..', 'assets', 'web-terminal.html');
    const htmlTemplate = fs.readFileSync(htmlPath, 'utf8');
    const htmlContent = htmlTemplate.replace('__WS_TOKEN__', password);
    const expectedAuth = 'Basic ' + Buffer.from(`infiniterm:${password}`).toString('base64');

    webTerminalServer = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth !== expectedAuth) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="infiniterm"' });
        res.end('Unauthorized');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
    });

    webTerminalWss = new WebSocketServer({ server: webTerminalServer, path: '/ws' });

    webTerminalWss.on('connection', (ws: WebSocket, req) => {
      const auth = req.headers.authorization;
      if (auth !== expectedAuth) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        if (token !== password) {
          ws.close(1008, 'Unauthorized');
          return;
        }
      }

      const env = resolveShellEnv(shellExe);
      const ptyProc = pty.spawn(shellExe, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env,
      });

      webTerminalPty = ptyProc;

      ptyProc.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });

      ptyProc.onExit(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });

      ws.on('message', (msg: Buffer | string) => {
        const str = msg.toString();
        try {
          const parsed = JSON.parse(str);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            ptyProc.resize(Math.max(1, parsed.cols), Math.max(1, parsed.rows));
            return;
          }
        } catch { /* not JSON, treat as input */ }
        ptyProc.write(str);
      });

      ws.on('close', () => {
        try { ptyProc.kill(); } catch {}
        if (webTerminalPty === ptyProc) webTerminalPty = null;
      });
    });

    await new Promise<void>((resolve, reject) => {
      webTerminalServer!.listen(port, '0.0.0.0', () => resolve());
      webTerminalServer!.on('error', reject);
    });

    const ips = getNetworkIPs();
    return {
      port,
      username: 'infiniterm',
      password,
      localUrl: `http://${ips.local}:${port}`,
      tailscaleUrl: ips.tailscale ? `http://${ips.tailscale}:${port}` : null,
    };
  }

  ipcMain.handle('web-terminal-start', async (_event, { port: requestedPort, password: requestedPassword }: { port?: number; password?: string }) => {
    const port = requestedPort || 7681;
    const password = requestedPassword || Math.random().toString(36).slice(2, 10);
    const result = await startWebTerminalServer(port, password);

    const localUrl = `http://infiniterm:${password}@${result.localUrl.replace('http://', '')}`;
    const tailscaleUrl = result.tailscaleUrl ? `http://infiniterm:${password}@${result.tailscaleUrl.replace('http://', '')}` : null;
    const qrTarget = tailscaleUrl ?? localUrl;
    const qrDataUrl = await QRCode.toDataURL(qrTarget, { width: 200, margin: 2 });

    return { ...result, qrDataUrl };
  });

  ipcMain.on('web-terminal-stop', () => {
    stopWebTerminal();
    webTerminalPassword = null;
    webTerminalPort = null;
    mainWindow?.webContents.send('web-terminal-stopped');
  });

  // ---- Graceful restart (preserves web terminal connection credentials) ----

  ipcMain.handle('graceful-restart', async () => {
    saveRestartState();
    app.relaunch();
    app.exit(0);
  });

  // Auto-restore web terminal from restart state
  const restartState = loadAndClearRestartState();
  if (restartState?.webTerminal) {
    const { password: savedPassword, port: savedPort } = restartState.webTerminal;
    mainWindow?.webContents.once('did-finish-load', async () => {
      try {
        const result = await startWebTerminalServer(savedPort, savedPassword);
        mainWindow?.webContents.send('web-terminal-restored', result);
      } catch (err) {
        console.error('Failed to restore web terminal:', err);
      }
    });
  }

  mainWindow?.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // macOS では全ウィンドウを閉じてもアプリを終了しない (標準的な挙動)
  if (!isMac) app.quit();
});

// macOS: Dock アイコンクリック時にウィンドウがなければ再作成
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
