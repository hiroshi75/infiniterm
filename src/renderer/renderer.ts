import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import { WebglAddon } from 'xterm-addon-webgl';
import 'xterm/css/xterm.css';
import { HorizontalMinimap } from './minimap';
import { DEFAULT_KEYBINDINGS, compileBindings, matchesBinding, CompiledAction } from './keybindings';
import { THEMES, AppSettings, DEFAULT_SETTINGS } from './themes';
import { t, setLanguage } from './i18n';

// ---- Window type augmentation ----

interface ShellEntry {
  id: string;
  label: string;
  exe: string;
  isMsys2: boolean;
}

interface SSHProfile {
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

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      listShells: () => Promise<{ shells: ShellEntry[]; defaultId: string }>;
      setDefaultShell: (id: string) => void;
      createPty: (opts: { shell?: string; cols: number; rows: number }) => Promise<{ id: number; shell: string }>;
      killPty: (id: number) => void;
      sendInput: (id: number, data: string) => void;
      resize: (id: number, cols: number, rows: number) => void;
      onData: (callback: (event: { id: number; data: string }) => void) => () => void;
      onExit: (callback: (event: { id: number; exitCode: number; signal?: number }) => void) => () => void;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      toggleFullscreen: () => void;
      getKeybindings: () => Promise<Record<string, string | string[]>>;
      sshProfilesList: () => Promise<SSHProfile[]>;
      sshProfileSave: (profile: SSHProfile) => void;
      sshProfileDelete: (id: string) => void;
      sshProfilePin: (id: string, pinned: boolean) => void;
      sshConnect: (opts: { profile: SSHProfile; cols: number; rows: number }) => Promise<{ id: number }>;
      sshDisconnect: (id: number) => void;
      sshResize: (id: number, cols: number, rows: number) => void;
      openFileDialog: () => Promise<string | null>;
      openInEditor: (opts: { file: string; line: number; col: number; cwd: string }) => Promise<{ type: string; command?: string }>;
      verifyFiles: (opts: { baseDir: string; candidates: string[] }) => Promise<Array<{ name: string; exists: boolean; isDir: boolean; fullPath: string }>>;
      getPtyCwd: (pid: number) => Promise<string>;
      getSettings: () => Promise<Record<string, any>>;
      saveSettings: (settings: Record<string, any>) => void;
      setWindowOpacity: (opacity: number) => void;
      // Sharing - host
      shareStart: (opts: { tabs: Array<{ id: number; title: string; cols: number; rows: number }>; activeTabId: number }) => Promise<{ port: number; code: string; ip: string; qrDataUrl: string; connectUrl: string }>;
      shareStop: () => void;
      shareTabAdded: (tab: { id: number; title: string; cols: number; rows: number }) => void;
      shareTabRemoved: (tabId: number) => void;
      shareTabActivated: (tabId: number) => void;
      shareTabTitle: (tabId: number, title: string) => void;
      shareTabResized: (tabId: number, cols: number, rows: number) => void;
      onShareClientCount: (callback: (count: number) => void) => () => void;
      // Sharing - client
      shareConnect: (opts: { host: string; port: number; code: string }) => Promise<{ ok: boolean }>;
      shareDisconnect: () => void;
      shareRemoteInput: (tabId: number, data: string) => void;
      onShareRemoteMessage: (callback: (msg: any) => void) => () => void;
      onShareRemoteDisconnected: (callback: () => void) => () => void;
    };
  }
}

// ---- Settings state ----
let appSettings: AppSettings = { ...DEFAULT_SETTINGS };

function getCurrentTheme() {
  return THEMES[appSettings.theme] ?? THEMES['catppuccin-mocha'];
}

// ---- State ----

interface TabSession {
  id: number;
  ptyId: number | null;
  pid: number | null;
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  pane: HTMLElement;
  tabEl: HTMLElement;
  title: string;
  removeDataListener: (() => void) | null;
  removeExitListener: (() => void) | null;
  isSsh?: boolean;
  isRemote?: boolean;
  remoteTabId?: number;
  cwd: string;
  lsContexts: Array<{ cwd: string; targetDir: string; startRow: number; endRow: number }>;
  minimapActivityMap: Float64Array | null;
  minimapVirtualWidth: number;  // px、0 = viewWidth と同じ（未拡張）
  minimapScrollX: number;       // px
}

let tabCounter = 0;
const sessions = new Map<number, TabSession>();
let activeTabId = -1;
let availableShells: ShellEntry[] = [];
let defaultShellId = '';
let sshProfiles: SSHProfile[] = [];
let editingProfileId: string | null = null;
let scrollRepeatCount = 0;
let currentFontSize = 14;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
let compiledBindings: CompiledAction[] = [];

// ---- Sharing state ----
let isSharing = false;
let isRemoteConnected = false;
const remoteTabIdMap = new Map<number, number>(); // remote tabId → local tabId
let removeShareClientCountListener: (() => void) | null = null;
let removeShareRemoteMessageListener: (() => void) | null = null;
let removeShareRemoteDisconnectedListener: (() => void) | null = null;

const stack    = document.getElementById('terminal-stack')!;
const tabbar   = document.getElementById('tabbar')!;
const newTabWrap = document.getElementById('new-tab-wrap')!;
const newTabBtn  = document.getElementById('btn-new-tab')!;
const titleText  = document.getElementById('title-text')!;
const shellPicker     = document.getElementById('shell-picker')!;
const shellPickerList = document.getElementById('shell-picker-list')!;

// ---- Minimap ----

const minimapCanvas  = document.getElementById('minimap-canvas') as HTMLCanvasElement;
const widthOverlay   = document.getElementById('width-overlay')!;
const minimapScrollThumb = document.getElementById('minimap-scroll-thumb')!;

const minimap = new HorizontalMinimap(minimapCanvas, widthOverlay, minimapScrollThumb);

// ミニマップ領域全体で wheel を消費 (canvas 外のハンドル・トラック部分もカバー)
document.getElementById('minimap-area')!.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
}, { passive: false });

minimap.onScrollChange = () => {
  const session = sessions.get(activeTabId);
  if (!session) return;
  session.minimapScrollX = minimap.getScrollX();
  applyTerminalScroll(session);
};

minimap.onVirtualWidthConfirmed = () => {
  const session = sessions.get(activeTabId);
  if (!session) return;
  session.minimapVirtualWidth = minimap.getVirtualWidth();
  session.minimapScrollX = minimap.getScrollX();
  resizeTerminalToVirtualWidth(session);
};

function applyTerminalScroll(session: TabSession): void {
  const xtermEl = session.pane.querySelector('.xterm') as HTMLElement | null;
  if (!xtermEl) return;
  const scrollX = session.minimapScrollX;
  xtermEl.style.transform = scrollX > 0 ? `translateX(${-scrollX}px)` : '';
}

function resizeTerminalToVirtualWidth(session: TabSession): void {
  const viewWidth = stack.clientWidth || 1;
  const vw = session.minimapVirtualWidth || viewWidth;

  // fitAddon で正しい rows と baseCols を取得
  session.fitAddon.fit();
  const rows = session.term.rows;
  const baseCols = session.term.cols;

  const ratio = vw / viewWidth;
  if (ratio <= 1.001) {
    // 通常幅に戻す
    applyTerminalScroll(session);
    return;
  }

  const newCols = Math.max(baseCols, Math.round(baseCols * ratio));
  session.term.resize(newCols, rows);
  applyTerminalScroll(session);

  // PTY もリサイズ
  if (session.ptyId !== null) {
    if (session.isSsh) {
      window.electronAPI.sshResize(session.ptyId, newCols, rows);
    } else {
      window.electronAPI.resize(session.ptyId, newCols, rows);
    }
  }
}

// ---- Search bar ----
const searchBar = document.getElementById('search-bar')!;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchCount = document.getElementById('search-count')!;
const searchPrevBtn = document.getElementById('search-prev')!;
const searchNextBtn = document.getElementById('search-next')!;
const searchCloseBtn = document.getElementById('search-close')!;

function openSearch(): void {
  searchBar.classList.add('open');
  searchInput.focus();
  searchInput.select();
}

function closeSearch(): void {
  searchBar.classList.remove('open');
  searchCount.textContent = '';
  const session = sessions.get(activeTabId);
  if (session) {
    session.searchAddon.clearDecorations();
    session.term.focus();
  }
}

function doSearch(direction: 'next' | 'prev'): void {
  const session = sessions.get(activeTabId);
  if (!session) return;
  const query = searchInput.value;
  if (!query) {
    session.searchAddon.clearDecorations();
    searchCount.textContent = '';
    return;
  }
  if (direction === 'next') {
    session.searchAddon.findNext(query, { decorations: { activeMatchColorOverviewRuler: '#f9e2af', matchOverviewRuler: '#585b70' } });
  } else {
    session.searchAddon.findPrevious(query, { decorations: { activeMatchColorOverviewRuler: '#f9e2af', matchOverviewRuler: '#585b70' } });
  }
}

searchInput.addEventListener('input', () => doSearch('next'));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doSearch(e.shiftKey ? 'prev' : 'next');
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});
searchPrevBtn.addEventListener('click', () => doSearch('prev'));
searchNextBtn.addEventListener('click', () => doSearch('next'));
searchCloseBtn.addEventListener('click', closeSearch);

// ---- Font zoom ----

function setFontSize(size: number): void {
  currentFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  for (const session of sessions.values()) {
    session.term.options.fontSize = currentFontSize;
    session.fitAddon.fit();
    if (session.ptyId !== null) {
      if (session.isSsh) {
        window.electronAPI.sshResize(session.ptyId, session.term.cols, session.term.rows);
      } else {
        window.electronAPI.resize(session.ptyId, session.term.cols, session.term.rows);
      }
    }
  }
}

// ---- WebGL renderer ----

function loadWebGL(term: Terminal): void {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch {
    // Canvas renderer fallback
  }
}

// ---- File link detection ----

const FILE_LINK_RE = /((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[\w]+|[a-zA-Z][\w.-]*\.[\w]+)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))/;

function registerFileLinks(term: Terminal, session: TabSession): void {
  term.registerLinkProvider({
    provideLinks(y: number, callback: (links: Array<{
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      text: string;
      decorations?: { pointerCursor: boolean; underline: boolean };
      activate: (event: MouseEvent, text: string) => void;
    }> | undefined) => void) {
      const bufLine = term.buffer.active.getLine(y - 1);
      if (!bufLine) { callback(undefined); return; }
      const text = bufLine.translateToString();

      const re = new RegExp(FILE_LINK_RE.source, 'g');
      const links: Array<{
        range: { start: { x: number; y: number }; end: { x: number; y: number } };
        text: string;
        decorations: { pointerCursor: boolean; underline: boolean };
        activate: (event: MouseEvent, text: string) => void;
      }> = [];

      let match;
      while ((match = re.exec(text)) !== null) {
        const filePath = match[1];
        const ln = parseInt(match[2] || match[4] || '1');
        const col = parseInt(match[3] || match[5] || '1');
        const startX = match.index + 1;
        const endX = match.index + match[0].length;

        links.push({
          range: { start: { x: startX, y }, end: { x: endX, y } },
          text: match[0],
          decorations: { pointerCursor: true, underline: true },
          activate: async () => {
            const result = await window.electronAPI.openInEditor({
              file: filePath, line: ln, col, cwd: session.cwd,
            });
            if (result.type === 'command' && result.command && session.ptyId !== null) {
              window.electronAPI.sendInput(session.ptyId, result.command + '\n');
            }
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}

function registerOsc7(term: Terminal, session: TabSession): void {
  term.parser.registerOscHandler(7, (data: string) => {
    try {
      const url = new URL(data);
      if (url.protocol === 'file:') {
        session.cwd = decodeURIComponent(url.pathname);
      }
    } catch { /* ignore malformed */ }
    return false;
  });
}

// ---- ls command tracking & filename links ----

function parseLsCommand(command: string): { isLs: boolean; targetDir: string } {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const lsAliases = ['ls', 'll', 'la', 'eza', 'exa', 'lsd', 'gls'];
  if (!lsAliases.some(a => cmd === a)) return { isLs: false, targetDir: '' };

  let targetDir = '';
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) { targetDir = parts[i]; break; }
  }
  return { isLs: true, targetDir };
}

function onCommandEnter(command: string, term: Terminal, session: TabSession): void {
  // Close any open ls context
  const open = session.lsContexts.find(c => c.endRow === -1);
  if (open) {
    open.endRow = term.buffer.active.baseY + term.buffer.active.cursorY;
  }

  const startRow = term.buffer.active.baseY + term.buffer.active.cursorY + 1;
  const ls = parseLsCommand(command);

  // Query actual CWD from OS (async), then update session and create ls context
  const updateCwd = session.pid
    ? window.electronAPI.getPtyCwd(session.pid)
    : Promise.resolve('');

  updateCwd.then(cwd => {
    if (cwd) session.cwd = cwd;

    if (ls.isLs) {
      session.lsContexts.push({
        cwd: session.cwd || '',
        targetDir: ls.targetDir,
        startRow,
        endRow: -1,
      });
      if (session.lsContexts.length > 50) {
        session.lsContexts.splice(0, session.lsContexts.length - 50);
      }
    }
  });
}

function extractFilenameCandidates(
  text: string, inLsContext: boolean,
): Array<{ name: string; startX: number; endX: number }> {
  const candidates: Array<{ name: string; startX: number; endX: number }> = [];
  const trimmed = text.trimStart();

  if (inLsContext) {
    // ls -l format: line starts with permission bits
    if (/^[dlcbsp-][-rwxsStT]{9}/.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 9) {
        const arrowIdx = parts.indexOf('->');
        const nameParts = arrowIdx > 8 ? parts.slice(8, arrowIdx) : parts.slice(8);
        const filename = nameParts.join(' ').replace(/[@*=/|]$/, '');
        if (filename) {
          const idx = text.lastIndexOf(filename);
          if (idx >= 0) {
            candidates.push({ name: filename, startX: idx + 1, endX: idx + filename.length });
          }
        }
      }
      return candidates;
    }
    // "total NNN" line
    if (/^total\s+\d+/.test(trimmed)) return candidates;
    // Columnar ls output
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const cleaned = m[0].replace(/[@*=/|]$/, '');
      if (!cleaned || cleaned === '.' || cleaned === '..') continue;
      if (/^\d+$/.test(cleaned)) continue;
      candidates.push({ name: cleaned, startX: m.index + 1, endX: m.index + m[0].length });
    }
  } else {
    // Outside ls context: only match tokens with file extensions
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const cleaned = m[0].replace(/[@*=/|]$/, '');
      if (!cleaned || cleaned.length < 2) continue;
      if (!/[a-zA-Z]/.test(cleaned)) continue;
      // Must have a file extension and not be a version number like 1.2.3
      if (/\.\w+$/.test(cleaned) && !/^\d+\.\d+/.test(cleaned)) {
        candidates.push({ name: cleaned, startX: m.index + 1, endX: m.index + m[0].length });
      }
    }
  }
  return candidates;
}

function registerFilenameLinks(term: Terminal, session: TabSession): void {
  term.registerLinkProvider({
    provideLinks(y: number, callback: (links: Array<{
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      text: string;
      decorations?: { pointerCursor: boolean; underline: boolean };
      activate: (event: MouseEvent, text: string) => void;
    }> | undefined) => void) {
      const bufLine = term.buffer.active.getLine(y - 1);
      if (!bufLine) { callback(undefined); return; }
      const text = bufLine.translateToString();
      if (!text.trim()) { callback(undefined); return; }

      const absRow = y - 1;

      // Find ls context for this line
      const ctx = session.lsContexts.find(c =>
        absRow >= c.startRow && (c.endRow === -1 || absRow <= c.endRow)
      );

      let baseDir: string;
      if (ctx) {
        baseDir = ctx.targetDir
          ? (ctx.targetDir.startsWith('/') ? ctx.targetDir : (ctx.cwd + '/' + ctx.targetDir))
          : ctx.cwd;
      } else {
        baseDir = session.cwd || '';
      }
      if (!baseDir) { callback(undefined); return; }

      const candidates = extractFilenameCandidates(text, !!ctx);
      if (candidates.length === 0) { callback(undefined); return; }

      window.electronAPI.verifyFiles({
        baseDir,
        candidates: candidates.map(c => c.name),
      }).then(results => {
        const links: Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } };
          text: string;
          decorations: { pointerCursor: boolean; underline: boolean };
          activate: (event: MouseEvent, text: string) => void;
        }> = [];
        for (let i = 0; i < results.length; i++) {
          if (!results[i].exists) continue;
          const c = candidates[i];
          const result = results[i];
          if (result.isDir) {
            // Directories: clicking cd's into them
            links.push({
              range: { start: { x: c.startX, y }, end: { x: c.endX, y } },
              text: c.name,
              decorations: { pointerCursor: true, underline: true },
              activate: () => {
                if (session.ptyId !== null) {
                  window.electronAPI.sendInput(session.ptyId, `cd ${result.fullPath}\n`);
                }
              },
            });
          } else {
            // Files: open in editor
            links.push({
              range: { start: { x: c.startX, y }, end: { x: c.endX, y } },
              text: c.name,
              decorations: { pointerCursor: true, underline: true },
              activate: async () => {
                const edResult = await window.electronAPI.openInEditor({
                  file: result.fullPath, line: 1, col: 1, cwd: baseDir,
                });
                if (edResult.type === 'command' && edResult.command && session.ptyId !== null) {
                  window.electronAPI.sendInput(session.ptyId, edResult.command + '\n');
                }
              },
            });
          }
        }
        callback(links.length > 0 ? links : undefined);
      }).catch(() => callback(undefined));
    },
  });
}

// ---- Settings dialog ----

const settingsDialog = document.getElementById('settings-dialog')!;
const settingsDialogClose = document.getElementById('settings-dialog-close')!;
const settingsTheme = document.getElementById('settings-theme') as HTMLSelectElement;
const settingsFontSize = document.getElementById('settings-font-size') as HTMLInputElement;
const settingsFontFamily = document.getElementById('settings-font-family') as HTMLInputElement;
const settingsCursorStyle = document.getElementById('settings-cursor-style') as HTMLSelectElement;
const settingsOpacity = document.getElementById('settings-opacity') as HTMLInputElement;
const settingsOpacityValue = document.getElementById('settings-opacity-value')!;
const settingsScrollback = document.getElementById('settings-scrollback') as HTMLInputElement;
const settingsCursorBlink = document.getElementById('settings-cursor-blink') as HTMLInputElement;
const settingsFileLink = document.getElementById('settings-file-link') as HTMLInputElement;
const settingsEditor = document.getElementById('settings-editor') as HTMLSelectElement;
const settingsLanguage = document.getElementById('settings-language') as HTMLSelectElement;
const settingsSaveBtn = document.getElementById('settings-save-btn')!;
const settingsCancelBtn = document.getElementById('settings-cancel-btn')!;

// Populate theme dropdown
for (const [id, theme] of Object.entries(THEMES)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = theme.label;
  settingsTheme.appendChild(opt);
}

settingsOpacity.addEventListener('input', () => {
  settingsOpacityValue.textContent = settingsOpacity.value + '%';
});

function openSettings(): void {
  // Populate fields from current settings
  settingsTheme.value = appSettings.theme;
  settingsFontSize.value = String(appSettings.fontSize);
  settingsFontFamily.value = appSettings.fontFamily;
  settingsCursorStyle.value = appSettings.cursorStyle;
  settingsOpacity.value = String(Math.round(appSettings.windowOpacity * 100));
  settingsOpacityValue.textContent = Math.round(appSettings.windowOpacity * 100) + '%';
  settingsScrollback.value = String(appSettings.scrollback);
  settingsCursorBlink.checked = appSettings.cursorBlink;
  settingsFileLink.checked = appSettings.fileLinkEnabled;
  settingsEditor.value = appSettings.editor;
  settingsLanguage.value = appSettings.language;
  settingsDialog.classList.add('open');
}

function closeSettings(): void {
  settingsDialog.classList.remove('open');
  const session = sessions.get(activeTabId);
  if (session) session.term.focus();
}

function applyTheme(themeId: string): void {
  const theme = THEMES[themeId];
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--bg-base', theme.ui.bgBase);
  root.style.setProperty('--bg-mantle', theme.ui.bgMantle);
  root.style.setProperty('--bg-surface', theme.ui.bgSurface);
  root.style.setProperty('--bg-surface1', theme.ui.bgSurface1);
  root.style.setProperty('--fg-base', theme.ui.fgBase);
  root.style.setProperty('--fg-sub', theme.ui.fgSub);
  root.style.setProperty('--accent', theme.ui.accent);
  root.style.setProperty('--red', theme.ui.red);
  root.style.setProperty('--green', theme.ui.green);
  root.style.setProperty('--yellow', theme.ui.yellow);

  for (const session of sessions.values()) {
    session.term.options.theme = theme.terminal;
  }
}

function applySettings(newSettings: AppSettings): void {
  const prevTheme = appSettings.theme;
  const prevLang = appSettings.language;
  appSettings = { ...newSettings };

  // Theme
  if (appSettings.theme !== prevTheme) {
    applyTheme(appSettings.theme);
  }

  // Font
  currentFontSize = appSettings.fontSize;
  for (const session of sessions.values()) {
    session.term.options.fontFamily = appSettings.fontFamily;
    session.term.options.fontSize = appSettings.fontSize;
    session.term.options.cursorBlink = appSettings.cursorBlink;
    session.term.options.cursorStyle = appSettings.cursorStyle;
    session.fitAddon.fit();
    if (session.ptyId !== null) {
      if (session.isSsh) {
        window.electronAPI.sshResize(session.ptyId, session.term.cols, session.term.rows);
      } else {
        window.electronAPI.resize(session.ptyId, session.term.cols, session.term.rows);
      }
    }
  }

  // Opacity
  window.electronAPI.setWindowOpacity(appSettings.windowOpacity);

  // Language
  if (appSettings.language !== prevLang) {
    setLanguage(appSettings.language);
    updateUILanguage();
  }

  // Save
  window.electronAPI.saveSettings(appSettings as any);
}

function updateUILanguage(): void {
  // Update data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')!;
    el.textContent = t(key);
  });
  // Update specific elements
  const settingsTitle = document.getElementById('settings-title');
  if (settingsTitle) settingsTitle.textContent = t('settings');
  // Shell picker
  const shellPickerHeader = document.querySelector('.shell-picker-header');
  if (shellPickerHeader) shellPickerHeader.textContent = t('selectShell');
  const shellPickerFooter = document.querySelector('.shell-picker-footer');
  if (shellPickerFooter) shellPickerFooter.textContent = t('rightClickDefault');
  // Search bar
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  if (searchInput) searchInput.placeholder = t('search');
  // Settings buttons
  const saveBtn = document.getElementById('settings-save-btn');
  if (saveBtn) saveBtn.textContent = t('save');
  const cancelBtn = document.getElementById('settings-cancel-btn');
  if (cancelBtn) cancelBtn.textContent = t('cancel');
  // Cursor style options
  const cursorOpts = settingsCursorStyle.options;
  cursorOpts[0].textContent = t('block');
  cursorOpts[1].textContent = t('underline');
  cursorOpts[2].textContent = t('bar');
  // Editor auto option
  settingsEditor.options[0].textContent = t('auto');
}

settingsSaveBtn.addEventListener('click', () => {
  applySettings({
    theme: settingsTheme.value,
    fontSize: parseInt(settingsFontSize.value) || 14,
    fontFamily: settingsFontFamily.value || DEFAULT_SETTINGS.fontFamily,
    cursorStyle: settingsCursorStyle.value as 'block' | 'underline' | 'bar',
    windowOpacity: parseInt(settingsOpacity.value) / 100,
    scrollback: parseInt(settingsScrollback.value) || 10000,
    cursorBlink: settingsCursorBlink.checked,
    fileLinkEnabled: settingsFileLink.checked,
    editor: settingsEditor.value,
    language: settingsLanguage.value,
  });
  closeSettings();
});

settingsCancelBtn.addEventListener('click', closeSettings);
settingsDialogClose.addEventListener('click', closeSettings);
settingsDialog.addEventListener('click', (e) => {
  if (e.target === settingsDialog) closeSettings();
});

document.getElementById('btn-settings')!.addEventListener('click', openSettings);

const sshDialog       = document.getElementById('ssh-dialog')!;
const sshDialogClose  = document.getElementById('ssh-dialog-close')!;
const sshViewHistory  = document.getElementById('ssh-view-history')!;
const sshViewForm     = document.getElementById('ssh-view-form')!;
const sshHistoryList  = document.getElementById('ssh-history-list')!;
const sshNewBtn       = document.getElementById('ssh-new-btn')!;
const sshBackBtn      = document.getElementById('ssh-back-btn')!;
const sshFormTitle    = document.getElementById('ssh-form-title')!;
const sshHost         = document.getElementById('ssh-host') as HTMLInputElement;
const sshPort         = document.getElementById('ssh-port') as HTMLInputElement;
const sshUsername     = document.getElementById('ssh-username') as HTMLInputElement;
const sshAuthPassword = document.getElementById('ssh-auth-password') as HTMLInputElement;
const sshAuthKey      = document.getElementById('ssh-auth-key') as HTMLInputElement;
const sshAuthBoth     = document.getElementById('ssh-auth-both') as HTMLInputElement;
const sshPasswordGroup = document.getElementById('ssh-password-group')!;
const sshKeyGroup     = document.getElementById('ssh-key-group')!;
const sshPasswordInput = document.getElementById('ssh-password') as HTMLInputElement;
const sshKeypath      = document.getElementById('ssh-keypath') as HTMLInputElement;
const sshKeypathBrowse = document.getElementById('ssh-keypath-browse')!;
const sshStatus       = document.getElementById('ssh-status')!;
const sshConnectBtn   = document.getElementById('ssh-connect-btn') as HTMLButtonElement;
const sshCancelBtn    = document.getElementById('ssh-cancel-btn')!;

// ---- Shell picker ----

function shellIcon(s: ShellEntry): string {
  if (s.isMsys2) return '🐧';
  if (s.label.toLowerCase().includes('powershell 7') || s.id === 'pwsh7') return '💠';
  if (s.label.toLowerCase().includes('powershell') || s.id === 'pwsh5') return '🔵';
  if (s.id === 'cmd') return '⬛';
  if (s.id === 'zsh') return '🐚';
  if (s.id === 'bash') return '🖥';
  if (s.id === 'fish') return '🐟';
  return '>';
}

function renderShellPicker(): void {
  shellPickerList.innerHTML = '';
  for (const s of availableShells) {
    const btn = document.createElement('button');
    btn.className = 'shell-option';
    btn.dataset.shellId = s.id;
    btn.innerHTML = `
      <span class="shell-icon">${shellIcon(s)}</span>
      <span class="shell-info">
        <div class="shell-name">${s.label}</div>
        <div class="shell-path">${s.exe}</div>
      </span>
      ${s.id === defaultShellId ? '<span class="default-badge">デフォルト</span>' : ''}
    `;

    // Left click: open new tab
    btn.addEventListener('click', () => {
      closeShellPicker();
      createTab(s.exe);
    });

    // Right click: set as default
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      defaultShellId = s.id;
      window.electronAPI.setDefaultShell(s.id);
      renderShellPicker();
    });

    shellPickerList.appendChild(btn);
  }

  // SSH divider & entry
  const divider = document.createElement('div');
  divider.className = 'shell-picker-divider';
  shellPickerList.appendChild(divider);

  const sshBtn = document.createElement('button');
  sshBtn.className = 'shell-option';
  sshBtn.innerHTML = `
    <span class="shell-icon">🔐</span>
    <span class="shell-info">
      <div class="shell-name">SSH 接続...</div>
      <div class="shell-path">リモートサーバーに接続</div>
    </span>
  `;
  sshBtn.addEventListener('click', () => {
    closeShellPicker();
    openSshDialog();
  });
  shellPickerList.appendChild(sshBtn);
}

function openShellPicker(): void {
  if (availableShells.length === 0) return;
  renderShellPicker();

  const rect = newTabWrap.getBoundingClientRect();
  shellPicker.style.left = `${rect.left}px`;
  shellPicker.style.top  = `${rect.bottom + 4}px`;
  shellPicker.classList.add('open');
}

function closeShellPicker(): void {
  shellPicker.classList.remove('open');
}

newTabBtn.addEventListener('click', () => {
  if (shellPicker.classList.contains('open')) {
    closeShellPicker();
    return;
  }
  openShellPicker();
});

document.addEventListener('click', (e) => {
  if (!shellPicker.contains(e.target as Node) && e.target !== newTabBtn) {
    closeShellPicker();
  }
});

// ---- Terminal factory ----

function createTerminal(): { term: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const term = new Terminal({
    fontFamily: appSettings.fontFamily,
    fontSize: currentFontSize,
    lineHeight: 1.2,
    letterSpacing: 0,
    theme: getCurrentTheme().terminal,
    cursorBlink: appSettings.cursorBlink,
    cursorStyle: appSettings.cursorStyle,
    scrollback: appSettings.scrollback,
    windowsMode: false,
    convertEol: false,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const webLinksAddon = new WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(webLinksAddon);
  return { term, fitAddon, searchAddon };
}

// ---- Clipboard helpers ----

function attachClipboard(pane: HTMLElement, term: Terminal, session: TabSession): void {
  // 選択 → 自動コピー
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });

  // ペースト共通関数
  const pasteToSession = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (session.isRemote && session.remoteTabId !== undefined) {
        window.electronAPI.shareRemoteInput(session.remoteTabId, text);
      } else if (session.ptyId !== null) {
        window.electronAPI.sendInput(session.ptyId, text);
      }
    } catch {}
  };

  // 右クリック → ペースト
  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    pasteToSession();
  });

  // macOS: Cmd+クリック → ペースト
  if (window.electronAPI.platform === 'darwin') {
    pane.addEventListener('mousedown', async (e) => {
      if (e.metaKey && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        pasteToSession();
      }
    }, true);
  }
}

// ---- Tab management ----

async function createTab(shellExe?: string): Promise<void> {
  tabCounter++;
  const tabId = tabCounter;

  // Build pane
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.tabId = String(tabId);
  stack.appendChild(pane);

  // Build terminal
  const { term, fitAddon, searchAddon } = createTerminal();
  term.open(pane);
  loadWebGL(term);

  // Build tab element — insert before the new-tab-wrap
  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = String(tabId);
  tabEl.innerHTML = `
    <span class="tab-title">Terminal ${tabId}</span>
    <span class="tab-close" data-close="${tabId}">&#10005;</span>
  `;
  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', String(tabId));
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    tabbar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
  });
  tabEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const dragging = tabbar.querySelector('.tab.dragging');
    if (!dragging || dragging === tabEl) return;
    tabbar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
    const rect = tabEl.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      tabEl.classList.add('drag-over-left');
    } else {
      tabEl.classList.add('drag-over-right');
    }
  });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragging = tabbar.querySelector('.tab.dragging') as HTMLElement | null;
    if (!dragging || dragging === tabEl) return;
    tabbar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
    const rect = tabEl.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      tabbar.insertBefore(dragging, tabEl);
    } else {
      if (tabEl.nextSibling) {
        tabbar.insertBefore(dragging, tabEl.nextSibling);
      } else {
        tabbar.appendChild(dragging);
      }
    }
  });
  tabbar.insertBefore(tabEl, newTabWrap);

  const session: TabSession = {
    id: tabId, ptyId: null, pid: null, term, fitAddon,
    searchAddon,
    pane, tabEl, title: `Terminal ${tabId}`,
    removeDataListener: null, removeExitListener: null,
    cwd: '',
    lsContexts: [],
    minimapActivityMap: null,
    minimapVirtualWidth: 0,
    minimapScrollX: 0,
  };
  sessions.set(tabId, session);
  registerOsc7(term, session);
  registerFileLinks(term, session);
  registerFilenameLinks(term, session);
  attachClipboard(pane, term, session);

  activateTab(tabId);

  // レイアウト確定を待ってからfitし、正しいcols/rowsでPTYを作成
  // (2フレーム待つ: 1フレーム目でDOMリフロー、2フレーム目で確定)
  await new Promise<void>(resolve => requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      fitAddon.fit();
      resolve();
    })
  ));

  // Connect to PTY
  try {
    const result = await window.electronAPI.createPty({
      shell: shellExe,
      cols: term.cols,
      rows: term.rows,
    });

    session.ptyId = result.id;
    session.pid = (result as any).pid ?? null;
    session.cwd = (result as any).cwd ?? '';

    const shellName = result.shell.split(/[\\/]/).pop()?.replace(/\.(exe)$/i, '') ?? 'shell';
    setTabTitle(session, shellName);

    const removeData = window.electronAPI.onData((event) => {
      if (event.id === result.id) term.write(event.data);
    });
    const removeExit = window.electronAPI.onExit((event) => {
      if (event.id === result.id) {
        term.write(`\r\n\x1b[33m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
        session.ptyId = null;
        setTabTitle(session, `[ended] ${session.title}`);
      }
    });
    session.removeDataListener = removeData;
    session.removeExitListener = removeExit;

    let cmdBuf = '';
    term.onData((data: string) => {
      if (session.ptyId !== null) window.electronAPI.sendInput(result.id, data);
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = cmdBuf.trim();
          if (cmd) onCommandEnter(cmd, term, session);
          cmdBuf = '';
        } else if (ch === '\x7f' || ch === '\b') {
          cmdBuf = cmdBuf.slice(0, -1);
        } else if (ch === '\x03') {
          cmdBuf = '';
        } else if (ch >= ' ') {
          cmdBuf += ch;
        }
      }
    });
    term.onResize(({ cols, rows }) => {
      if (session.ptyId !== null) {
        window.electronAPI.resize(result.id, cols, rows);
        if (isSharing) window.electronAPI.shareTabResized(result.id, cols, rows);
      }
    });
    term.onTitleChange((title: string) => {
      if (title) setTabTitle(session, title);
    });

    // Notify sharing server
    if (isSharing) {
      window.electronAPI.shareTabAdded({
        id: result.id, title: session.title,
        cols: term.cols, rows: term.rows,
      });
    }

    // PTY接続後にレイアウト確定を待って最終リサイズを送る
    // (activateTab 内の RAF で fit() が走るタイミングより後に確実に実行)
    requestAnimationFrame(() => {
      fitAddon.fit();
      if (session.ptyId !== null) {
        window.electronAPI.resize(result.id, term.cols, term.rows);
      }
    });

  } catch (err) {
    term.write(`\r\n\x1b[31m[Failed to start PTY: ${err}]\x1b[0m\r\n`);
  }

  tabEl.addEventListener('click', (e) => {
    const closeBtn = (e.target as HTMLElement).closest('[data-close]');
    if (closeBtn) closeTab(tabId);
    else activateTab(tabId);
  });
}

function setTabTitle(session: TabSession, title: string): void {
  session.title = title;
  const titleEl = session.tabEl.querySelector('.tab-title');
  if (titleEl) titleEl.textContent = title;
  if (session.id === activeTabId) {
    titleText.textContent = `infiniterm — ${title}`;
  }
  if (isSharing && session.ptyId !== null) {
    window.electronAPI.shareTabTitle(session.ptyId, title);
  }
}

function activateTab(tabId: number): void {
  if (activeTabId !== -1) {
    const prev = sessions.get(activeTabId);
    if (prev) {
      prev.pane.classList.remove('active');
      prev.tabEl.classList.remove('active');
    }
  }
  activeTabId = tabId;
  const session = sessions.get(tabId);
  if (!session) return;
  session.pane.classList.add('active');
  session.tabEl.classList.add('active');
  titleText.textContent = `infiniterm — ${session.title}`;
  if (isSharing && session.ptyId !== null) {
    window.electronAPI.shareTabActivated(session.ptyId);
  }
  requestAnimationFrame(() => {
    session.fitAddon.fit();
    session.term.focus();
    // Minimap
    const viewWidth = stack.clientWidth || 1;
    const actMap = minimap.connect(
      session.term,
      session.minimapActivityMap,
      session.minimapVirtualWidth || viewWidth,
      session.minimapScrollX,
    );
    session.minimapActivityMap = actMap;
    minimap.setViewWidth(viewWidth);
    applyTerminalScroll(session);
  });
}

function closeTab(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) return;
  session.removeDataListener?.();
  session.removeExitListener?.();
  if (session.isRemote) {
    // Remote tab — just remove from mapping
    if (session.remoteTabId !== undefined) {
      remoteTabIdMap.delete(session.remoteTabId);
    }
  } else if (session.ptyId !== null) {
    if (isSharing) window.electronAPI.shareTabRemoved(session.ptyId);
    if (session.isSsh) {
      window.electronAPI.sshDisconnect(session.ptyId);
    } else {
      window.electronAPI.killPty(session.ptyId);
    }
  }
  if (tabId === activeTabId) minimap.disconnect();
  session.term.dispose();
  session.pane.remove();
  session.tabEl.remove();
  sessions.delete(tabId);

  if (activeTabId === tabId) {
    activeTabId = -1;
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      titleText.textContent = 'infiniterm';
      openShellPicker();
    }
  }
}

// ---- Resize observer ----

const resizeObserver = new ResizeObserver(() => {
  const session = sessions.get(activeTabId);
  if (!session) return;
  const viewWidth = stack.clientWidth || 1;
  minimap.setViewWidth(viewWidth);
  session.minimapVirtualWidth = minimap.getVirtualWidth();
  resizeTerminalToVirtualWidth(session);
});
resizeObserver.observe(stack);

// ---- Prevent macOS elastic overscroll ----
// capturing フェーズで最速に preventDefault を呼び、compositor の overscroll を阻止。
// xterm-viewport 内のスクロール (scrollback) だけは許可する。
document.addEventListener('wheel', (e) => {
  if ((e.target as HTMLElement).closest('.xterm-viewport')) return;
  e.preventDefault();
}, { passive: false, capture: true });

// ---- Window controls ----

document.getElementById('btn-minimize')!.addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('btn-maximize')!.addEventListener('click', () => window.electronAPI.maximize());
document.getElementById('btn-close')!.addEventListener('click',   () => window.electronAPI.close());

// ---- Keyboard shortcuts (keybinding-driven) ----

function switchToTab(idx: number): void {
  const ids = [...sessions.keys()];
  if (idx < ids.length) activateTab(ids[idx]);
}

const actionHandlers: Record<string, (e: KeyboardEvent) => void> = {
  newTab: () => openShellPicker(),
  closeTab: () => { if (activeTabId !== -1) closeTab(activeTabId); },
  nextTab: () => {
    const ids = [...sessions.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeTabId);
    activateTab(ids[(idx + 1) % ids.length]);
  },
  prevTab: () => {
    const ids = [...sessions.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeTabId);
    activateTab(ids[(idx - 1 + ids.length) % ids.length]);
  },
  search: () => openSearch(),
  zoomIn: () => setFontSize(currentFontSize + 2),
  zoomOut: () => setFontSize(currentFontSize - 2),
  zoomReset: () => setFontSize(DEFAULT_FONT_SIZE),
  fullscreen: () => window.electronAPI.toggleFullscreen(),
  settings: () => openSettings(),
  expandWidth: () => minimap.adjustVirtualWidth(40),
  shrinkWidth: () => minimap.adjustVirtualWidth(-40),
  resetWidth: () => minimap.resetVirtualWidth(),
  scrollRight: (e) => {
    if (e.repeat) scrollRepeatCount++;
    else scrollRepeatCount = 0;
    const speed = Math.min(40 + scrollRepeatCount * 12, 400);
    minimap.scrollBy(speed);
  },
  scrollLeft: (e) => {
    if (e.repeat) scrollRepeatCount++;
    else scrollRepeatCount = 0;
    const speed = Math.min(40 + scrollRepeatCount * 12, 400);
    minimap.scrollBy(-speed);
  },
  tab1: () => switchToTab(0),
  tab2: () => switchToTab(1),
  tab3: () => switchToTab(2),
  tab4: () => switchToTab(3),
  tab5: () => switchToTab(4),
  tab6: () => switchToTab(5),
  tab7: () => switchToTab(6),
  tab8: () => switchToTab(7),
  tab9: () => switchToTab(8),
};

// capture: true で xterm.js より先にキーを処理し、PTY への送信を防ぐ
document.addEventListener('keydown', (e) => {
  // ダイアログが開いている場合はEscapeで閉じる
  if (e.key === 'Escape') {
    if (shareDialog.classList.contains('open')) {
      e.preventDefault(); e.stopPropagation(); closeShareDialog(); return;
    }
    if (connectDialog.classList.contains('open')) {
      e.preventDefault(); e.stopPropagation(); closeConnectDialog(); return;
    }
  }
  if (settingsDialog.classList.contains('open') && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSettings();
    return;
  }

  // 検索バーが開いている場合はEscapeで閉じる (他のキーはsearchInputで処理)
  if (searchBar.classList.contains('open') && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
    return;
  }

  // macOS: Cmd+C (選択があればコピー、なければ Ctrl+C シグナル) / Cmd+V (ペースト)
  if (window.electronAPI.platform === 'darwin' && e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.code === 'KeyC') {
      const session = sessions.get(activeTabId);
      if (session) {
        const sel = session.term.getSelection();
        if (sel) {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard.writeText(sel).catch(() => {});
          return;
        }
      }
    }
    if (e.code === 'KeyV') {
      e.preventDefault();
      e.stopPropagation();
      const session = sessions.get(activeTabId);
      if (session) {
        navigator.clipboard.readText().then(text => {
          if (!text) return;
          if (session.isRemote && session.remoteTabId !== undefined) {
            window.electronAPI.shareRemoteInput(session.remoteTabId, text);
          } else if (session.ptyId !== null) {
            window.electronAPI.sendInput(session.ptyId, text);
          }
        }).catch(() => {});
      }
      return;
    }
  }

  for (const { binding, action } of compiledBindings) {
    if (matchesBinding(e, binding)) {
      e.preventDefault();
      e.stopPropagation();
      const handler = actionHandlers[action];
      if (handler) handler(e);
      return;
    }
  }
}, true);

// ---- SSH Dialog ----

function openSshDialog(): void {
  sshDialog.classList.add('open');
  loadSshHistory();
  showSshHistory();
}

function closeSshDialog(): void {
  sshDialog.classList.remove('open');
  editingProfileId = null;
}

function showSshHistory(): void {
  sshViewHistory.style.display = '';
  sshViewForm.style.display = 'none';
}

function showSshForm(profile?: SSHProfile): void {
  sshViewHistory.style.display = 'none';
  sshViewForm.style.display = '';
  sshStatus.textContent = '';
  sshStatus.className = '';

  if (profile) {
    editingProfileId = profile.id;
    sshFormTitle.textContent = '接続を編集';
    sshHost.value = profile.host;
    sshPort.value = String(profile.port);
    sshUsername.value = profile.username;
    sshAuthPassword.checked = profile.authType === 'password';
    sshAuthKey.checked = profile.authType === 'key';
    sshAuthBoth.checked = profile.authType === 'both';
    sshPasswordInput.value = profile.password ?? '';
    sshKeypath.value = profile.keyPath ?? '';
  } else {
    editingProfileId = null;
    sshFormTitle.textContent = '新しい接続';
    sshHost.value = '';
    sshPort.value = '22';
    sshUsername.value = '';
    sshAuthPassword.checked = true;
    sshPasswordInput.value = '';
    sshKeypath.value = '';
  }
  updateAuthFields();
  sshHost.focus();
}

function updateAuthFields(): void {
  const type = sshAuthBoth.checked ? 'both' : sshAuthKey.checked ? 'key' : 'password';
  sshPasswordGroup.style.display = (type === 'password' || type === 'both') ? '' : 'none';
  sshKeyGroup.style.display = (type === 'key' || type === 'both') ? '' : 'none';
  const label = document.getElementById('ssh-password-label')!;
  if (type === 'key') {
    label.textContent = 'パスフレーズ (省略可)';
  } else {
    label.textContent = 'パスワード';
  }
}

async function loadSshHistory(): Promise<void> {
  sshProfiles = await window.electronAPI.sshProfilesList();
  renderSshHistory();
}

function renderSshHistory(): void {
  const pinned = sshProfiles.filter(p => p.pinned).sort((a, b) => b.lastUsed - a.lastUsed);
  const recent = sshProfiles.filter(p => !p.pinned).sort((a, b) => b.lastUsed - a.lastUsed);
  const sorted = [...pinned, ...recent];

  if (sorted.length === 0) {
    sshHistoryList.innerHTML = '<li class="ssh-history-empty">接続履歴がありません</li>';
    return;
  }

  sshHistoryList.innerHTML = '';

  for (const profile of sorted) {
    const li = document.createElement('li');
    li.className = 'ssh-history-item';
    li.innerHTML = `
      <span class="ssh-hist-icon">${profile.pinned ? '📌' : '🖥'}</span>
      <span class="ssh-hist-info">
        <div class="ssh-hist-label">${escapeHtml(profile.label)}</div>
        <div class="ssh-hist-meta">${escapeHtml(profile.username)}@${escapeHtml(profile.host)}:${profile.port} · ${profile.useCount}回接続</div>
      </span>
      <button class="ssh-hist-pin-btn ${profile.pinned ? 'pinned' : ''}" title="${profile.pinned ? 'ピン解除' : 'ピン固定'}">📌</button>
      <button class="ssh-hist-edit-btn" title="編集">✏️</button>
      <button class="ssh-hist-del-btn" title="削除">🗑</button>
    `;

    // Row click → connect
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      connectSsh(profile);
    });

    // Pin button
    li.querySelector('.ssh-hist-pin-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      profile.pinned = !profile.pinned;
      window.electronAPI.sshProfilePin(profile.id, profile.pinned);
      renderSshHistory();
    });

    // Edit button
    li.querySelector('.ssh-hist-edit-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      showSshForm(profile);
    });

    // Delete button
    li.querySelector('.ssh-hist-del-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      sshProfiles = sshProfiles.filter(p => p.id !== profile.id);
      window.electronAPI.sshProfileDelete(profile.id);
      renderSshHistory();
    });

    sshHistoryList.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function connectSsh(profile: SSHProfile): Promise<void> {
  closeSshDialog();

  tabCounter++;
  const tabId = tabCounter;

  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.tabId = String(tabId);
  stack.appendChild(pane);

  const { term, fitAddon, searchAddon } = createTerminal();
  // term.open() は activateTab() でペインが表示された後に呼ぶ
  // (display:none 状態で open すると xterm.js が文字幅を測定できず cols が狂う)

  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = String(tabId);
  tabEl.innerHTML = `
    <span class="tab-title">🔐 ${escapeHtml(profile.label)}</span>
    <span class="tab-close" data-close="${tabId}">&#10005;</span>
  `;
  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', String(tabId));
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    tabbar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
  });
  tabEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const dragging = tabbar.querySelector('.tab.dragging');
    if (!dragging || dragging === tabEl) return;
    tabbar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
    const rect = tabEl.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      tabEl.classList.add('drag-over-left');
    } else {
      tabEl.classList.add('drag-over-right');
    }
  });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragging = tabbar.querySelector('.tab.dragging') as HTMLElement | null;
    if (!dragging || dragging === tabEl) return;
    tabbar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
    const rect = tabEl.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      tabbar.insertBefore(dragging, tabEl);
    } else {
      if (tabEl.nextSibling) {
        tabbar.insertBefore(dragging, tabEl.nextSibling);
      } else {
        tabbar.appendChild(dragging);
      }
    }
  });
  tabbar.insertBefore(tabEl, newTabWrap);

  const session: TabSession = {
    id: tabId, ptyId: null, pid: null, term, fitAddon,
    searchAddon,
    pane, tabEl, title: profile.label,
    removeDataListener: null, removeExitListener: null,
    isSsh: true,
    cwd: '',
    lsContexts: [],
    minimapActivityMap: null,
    minimapVirtualWidth: 0,
    minimapScrollX: 0,
  };
  sessions.set(tabId, session);

  // ペインを表示状態にしてから open — 正しい文字幅測定のため
  activateTab(tabId);
  term.open(pane);
  loadWebGL(term);
  registerOsc7(term, session);
  registerFileLinks(term, session);
  registerFilenameLinks(term, session);
  attachClipboard(pane, term, session);

  // RAF を待って fit — DOM レイアウト確定後に正確な cols/rows を取得
  await new Promise<void>(resolve => requestAnimationFrame(() => { fitAddon.fit(); resolve(); }));

  term.write(`\r\n  \x1b[36m接続中: ${profile.username}@${profile.host}:${profile.port} ...\x1b[0m\r\n`);

  try {
    const updatedProfile: SSHProfile = {
      ...profile,
      lastUsed: Date.now(),
      useCount: profile.useCount + 1,
    };
    window.electronAPI.sshProfileSave(updatedProfile);

    const result = await window.electronAPI.sshConnect({
      profile: updatedProfile,
      cols: term.cols,
      rows: term.rows,
    });

    session.ptyId = result.id;
    setTabTitle(session, profile.label);

    if (isSharing) {
      window.electronAPI.shareTabAdded({
        id: result.id, title: session.title,
        cols: term.cols, rows: term.rows,
      });
    }

    const removeData = window.electronAPI.onData((event) => {
      if (event.id === result.id) term.write(event.data);
    });
    const removeExit = window.electronAPI.onExit((event) => {
      if (event.id === result.id) {
        term.write(`\r\n\x1b[33m[SSH セッション終了 (code ${event.exitCode})]\x1b[0m\r\n`);
        session.ptyId = null;
        setTabTitle(session, `[切断] ${session.title}`);
      }
    });
    session.removeDataListener = removeData;
    session.removeExitListener = removeExit;

    let cmdBuf = '';
    term.onData((data: string) => {
      if (session.ptyId !== null) window.electronAPI.sendInput(result.id, data);
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = cmdBuf.trim();
          if (cmd) onCommandEnter(cmd, term, session);
          cmdBuf = '';
        } else if (ch === '\x7f' || ch === '\b') {
          cmdBuf = cmdBuf.slice(0, -1);
        } else if (ch === '\x03') {
          cmdBuf = '';
        } else if (ch >= ' ') {
          cmdBuf += ch;
        }
      }
    });
    term.onResize(({ cols, rows }) => {
      if (session.ptyId !== null) {
        window.electronAPI.sshResize(result.id, cols, rows);
        if (isSharing) window.electronAPI.shareTabResized(result.id, cols, rows);
      }
    });
    // 接続確立後にレイアウト確定を待って最終リサイズを送る
    requestAnimationFrame(() => {
      fitAddon.fit();
      if (session.ptyId !== null) {
        window.electronAPI.sshResize(result.id, term.cols, term.rows);
      }
    });

  } catch (err) {
    term.write(`\r\n\x1b[31m[SSH 接続失敗: ${err}]\x1b[0m\r\n`);
    session.ptyId = null;
  }

  tabEl.addEventListener('click', (e) => {
    const closeBtn = (e.target as HTMLElement).closest('[data-close]');
    if (closeBtn) closeTab(tabId);
    else activateTab(tabId);
  });
}

async function handleSshConnect(): Promise<void> {
  const host = sshHost.value.trim();
  const port = parseInt(sshPort.value) || 22;
  const username = sshUsername.value.trim();
  const authType = sshAuthBoth.checked ? 'both' : sshAuthKey.checked ? 'key' : 'password';
  const password = sshPasswordInput.value;
  const keyPath = sshKeypath.value.trim();

  if (!host) { sshStatus.textContent = 'ホストを入力してください'; return; }
  if (!username) { sshStatus.textContent = 'ユーザー名を入力してください'; return; }

  const label = editingProfileId
    ? (sshProfiles.find(p => p.id === editingProfileId)?.label ?? `${username}@${host}`)
    : `${username}@${host}`;

  const profile: SSHProfile = {
    id: editingProfileId ?? crypto.randomUUID(),
    label,
    host,
    port,
    username,
    authType,
    password: password || undefined,
    keyPath: keyPath || undefined,
    pinned: sshProfiles.find(p => p.id === editingProfileId)?.pinned ?? false,
    lastUsed: Date.now(),
    useCount: 0,
  };

  sshStatus.textContent = '接続中...';
  sshStatus.className = '';
  sshConnectBtn.disabled = true;

  try {
    window.electronAPI.sshProfileSave(profile);
    closeSshDialog();
    await connectSsh(profile);
  } catch (err) {
    sshStatus.textContent = `接続失敗: ${err}`;
    sshConnectBtn.disabled = false;
  }
}

// SSH Dialog events
sshDialogClose.addEventListener('click', closeSshDialog);
sshNewBtn.addEventListener('click', () => showSshForm());
sshBackBtn.addEventListener('click', showSshHistory);
sshCancelBtn.addEventListener('click', () => {
  if (sshViewForm.style.display !== 'none') showSshHistory();
  else closeSshDialog();
});

sshConnectBtn.addEventListener('click', handleSshConnect);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sshDialog.classList.contains('open')) {
    closeSshDialog();
  }
});

[sshAuthPassword, sshAuthKey, sshAuthBoth].forEach(r =>
  r.addEventListener('change', updateAuthFields)
);

sshKeypathBrowse.addEventListener('click', async () => {
  const path = await window.electronAPI.openFileDialog();
  if (path) sshKeypath.value = path;
});

sshDialog.addEventListener('click', (e) => {
  if (e.target === sshDialog) closeSshDialog();
});

// ---- Sharing dialogs ----

const shareDialog = document.getElementById('share-dialog')!;
const shareDialogClose = document.getElementById('share-dialog-close')!;
const shareStartBtn = document.getElementById('share-start-btn')!;
const shareStopBtn = document.getElementById('share-stop-btn')!;
const shareInactiveView = document.getElementById('share-inactive-view')!;
const shareActiveView = document.getElementById('share-active-view')!;
const shareQrImg = document.getElementById('share-qr') as HTMLImageElement;
const shareCodeDisplay = document.getElementById('share-code-display')!;
const shareConnectInfo = document.getElementById('share-connect-info')!;
const shareClientCount = document.getElementById('share-client-count')!;

const connectDialog = document.getElementById('connect-dialog')!;
const connectDialogClose = document.getElementById('connect-dialog-close')!;
const connectHostInput = document.getElementById('connect-host') as HTMLInputElement;
const connectPortInput = document.getElementById('connect-port') as HTMLInputElement;
const connectCodeInput = document.getElementById('connect-code') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn')!;
const connectCancelBtn = document.getElementById('connect-cancel-btn')!;
const connectStatus = document.getElementById('connect-status')!;

function openShareDialog(): void {
  shareDialog.classList.add('open');
  updateShareDialogView();
}

function closeShareDialog(): void {
  shareDialog.classList.remove('open');
  const session = sessions.get(activeTabId);
  if (session) session.term.focus();
}

function updateShareDialogView(): void {
  if (isSharing) {
    shareInactiveView.style.display = 'none';
    shareActiveView.style.display = '';
    shareStartBtn.style.display = 'none';
    shareStopBtn.style.display = '';
  } else {
    shareInactiveView.style.display = '';
    shareActiveView.style.display = 'none';
    shareStartBtn.style.display = '';
    shareStopBtn.style.display = 'none';
  }
}

shareStartBtn.addEventListener('click', async () => {
  // Gather current tabs info (use ptyId as the shared tab id)
  const tabs: Array<{ id: number; title: string; cols: number; rows: number }> = [];
  let activeSharedTabId = -1;
  for (const session of sessions.values()) {
    if (session.ptyId !== null && !session.isRemote) {
      tabs.push({
        id: session.ptyId,
        title: session.title,
        cols: session.term.cols,
        rows: session.term.rows,
      });
      if (session.id === activeTabId) activeSharedTabId = session.ptyId;
    }
  }
  if (activeSharedTabId === -1 && tabs.length > 0) activeSharedTabId = tabs[0].id;

  try {
    const info = await window.electronAPI.shareStart({ tabs, activeTabId: activeSharedTabId });
    isSharing = true;

    shareQrImg.src = info.qrDataUrl;
    shareCodeDisplay.textContent = info.code;
    shareConnectInfo.textContent = `${info.ip}:${info.port}`;
    shareClientCount.textContent = t('connectedClients', 0);

    removeShareClientCountListener?.();
    removeShareClientCountListener = window.electronAPI.onShareClientCount((count) => {
      shareClientCount.textContent = t('connectedClients', count);
    });

    updateShareDialogView();
  } catch (err) {
    console.error('Failed to start sharing:', err);
  }
});

shareStopBtn.addEventListener('click', () => {
  window.electronAPI.shareStop();
  isSharing = false;
  removeShareClientCountListener?.();
  removeShareClientCountListener = null;
  updateShareDialogView();
});

shareDialogClose.addEventListener('click', closeShareDialog);
shareDialog.addEventListener('click', (e) => {
  if (e.target === shareDialog) closeShareDialog();
});

document.getElementById('btn-share')!.addEventListener('click', openShareDialog);
document.getElementById('btn-connect')!.addEventListener('click', openConnectDialog);

// ---- Connect dialog ----

function openConnectDialog(): void {
  connectDialog.classList.add('open');
  connectStatus.textContent = '';
  connectStatus.className = '';
  connectHostInput.focus();
}

function closeConnectDialog(): void {
  connectDialog.classList.remove('open');
  const session = sessions.get(activeTabId);
  if (session) session.term.focus();
}

connectBtn.addEventListener('click', async () => {
  const host = connectHostInput.value.trim();
  const port = parseInt(connectPortInput.value) || 0;
  const code = connectCodeInput.value.trim();

  if (!host || !port || !code) {
    connectStatus.textContent = t('connectFailed');
    connectStatus.className = 'error';
    return;
  }

  connectStatus.textContent = t('connecting');
  connectStatus.className = '';

  try {
    await window.electronAPI.shareConnect({ host, port, code });
    isRemoteConnected = true;
    connectStatus.textContent = '';
    closeConnectDialog();

    // Set up remote message handler
    removeShareRemoteMessageListener?.();
    removeShareRemoteMessageListener = window.electronAPI.onShareRemoteMessage((msg) => {
      handleRemoteMessage(msg);
    });

    removeShareRemoteDisconnectedListener?.();
    removeShareRemoteDisconnectedListener = window.electronAPI.onShareRemoteDisconnected(() => {
      isRemoteConnected = false;
      // Close all remote tabs
      for (const [localId, session] of sessions) {
        if (session.isRemote) closeTab(localId);
      }
      remoteTabIdMap.clear();
      removeShareRemoteMessageListener?.();
      removeShareRemoteMessageListener = null;
      removeShareRemoteDisconnectedListener?.();
      removeShareRemoteDisconnectedListener = null;
    });
  } catch (err) {
    connectStatus.textContent = t('connectFailed') + `: ${err}`;
    connectStatus.className = 'error';
  }
});

connectCancelBtn.addEventListener('click', closeConnectDialog);
connectDialogClose.addEventListener('click', closeConnectDialog);
connectDialog.addEventListener('click', (e) => {
  if (e.target === connectDialog) closeConnectDialog();
});

// ---- Remote tab handling ----

function createRemoteTab(remoteTabId: number, title: string, cols: number, rows: number): void {
  tabCounter++;
  const tabId = tabCounter;

  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.tabId = String(tabId);
  stack.appendChild(pane);

  const term = new Terminal({
    fontFamily: appSettings.fontFamily,
    fontSize: currentFontSize,
    lineHeight: 1.2,
    letterSpacing: 0,
    theme: getCurrentTheme().terminal,
    cursorBlink: false,
    cursorStyle: appSettings.cursorStyle,
    cols,
    rows,
    scrollback: appSettings.scrollback,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.open(pane);

  const tabEl = document.createElement('button');
  tabEl.className = 'tab remote-tab';
  tabEl.dataset.tabId = String(tabId);
  tabEl.innerHTML = `
    <span class="tab-title">${t('remoteTab')}: ${title}</span>
    <span class="tab-close" data-close="${tabId}">&#10005;</span>
  `;
  tabbar.insertBefore(tabEl, newTabWrap);

  const session: TabSession = {
    id: tabId, ptyId: null, pid: null, term, fitAddon,
    searchAddon,
    pane, tabEl, title: `${t('remoteTab')}: ${title}`,
    removeDataListener: null, removeExitListener: null,
    isRemote: true,
    remoteTabId,
    cwd: '',
    lsContexts: [],
    minimapActivityMap: null,
    minimapVirtualWidth: 0,
    minimapScrollX: 0,
  };

  sessions.set(tabId, session);
  remoteTabIdMap.set(remoteTabId, tabId);

  // Remote input: send to host via WebSocket
  term.onData((data: string) => {
    window.electronAPI.shareRemoteInput(remoteTabId, data);
  });

  attachClipboard(pane, term, session);

  tabEl.addEventListener('click', (e) => {
    const closeBtn = (e.target as HTMLElement).closest('[data-close]');
    if (closeBtn) closeTab(tabId);
    else activateTab(tabId);
  });

  activateTab(tabId);
}

function handleRemoteMessage(msg: any): void {
  switch (msg.type) {
    case 'sync': {
      // Initial sync — create tabs
      for (const tab of msg.tabs) {
        createRemoteTab(tab.id, tab.title, tab.cols, tab.rows);
      }
      // Activate the right tab
      if (msg.activeTabId !== undefined) {
        const localId = remoteTabIdMap.get(msg.activeTabId);
        if (localId !== undefined) activateTab(localId);
      }
      break;
    }
    case 'buffer':
    case 'data': {
      const localId = remoteTabIdMap.get(msg.tabId);
      if (localId !== undefined) {
        const session = sessions.get(localId);
        if (session) session.term.write(msg.data);
      }
      break;
    }
    case 'tab-created': {
      const tab = msg.tab;
      if (!remoteTabIdMap.has(tab.id)) {
        createRemoteTab(tab.id, tab.title, tab.cols, tab.rows);
      }
      break;
    }
    case 'tab-closed': {
      const localId = remoteTabIdMap.get(msg.tabId);
      if (localId !== undefined) closeTab(localId);
      break;
    }
    case 'tab-activated': {
      const localId = remoteTabIdMap.get(msg.tabId);
      if (localId !== undefined) activateTab(localId);
      break;
    }
    case 'tab-title': {
      const localId = remoteTabIdMap.get(msg.tabId);
      if (localId !== undefined) {
        const session = sessions.get(localId);
        if (session) setTabTitle(session, `${t('remoteTab')}: ${msg.title}`);
      }
      break;
    }
    case 'resize': {
      const localId = remoteTabIdMap.get(msg.tabId);
      if (localId !== undefined) {
        const session = sessions.get(localId);
        if (session) {
          session.term.resize(msg.cols, msg.rows);
        }
      }
      break;
    }
  }
}

// ---- Boot ----

async function init(): Promise<void> {
  document.body.classList.add(`platform-${window.electronAPI.platform}`);

  // Load settings
  const savedSettings = await window.electronAPI.getSettings();
  appSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
  currentFontSize = appSettings.fontSize;
  setLanguage(appSettings.language);
  applyTheme(appSettings.theme);
  window.electronAPI.setWindowOpacity(appSettings.windowOpacity);
  updateUILanguage();

  // Load keybindings
  const userBindings = await window.electronAPI.getKeybindings();
  compiledBindings = compileBindings(DEFAULT_KEYBINDINGS, userBindings);

  const { shells, defaultId } = await window.electronAPI.listShells();
  availableShells = shells;
  defaultShellId = defaultId;

  if (shells.length === 0) {
    await createTab();
    return;
  }

  const def = shells.find(s => s.id === defaultId) ?? shells[0];
  await createTab(def.exe);
}

init();
