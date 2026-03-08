import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { HorizontalMinimap } from './minimap';

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
      sshProfilesList: () => Promise<SSHProfile[]>;
      sshProfileSave: (profile: SSHProfile) => void;
      sshProfileDelete: (id: string) => void;
      sshProfilePin: (id: string, pinned: boolean) => void;
      sshConnect: (opts: { profile: SSHProfile; cols: number; rows: number }) => Promise<{ id: number }>;
      sshDisconnect: (id: number) => void;
      sshResize: (id: number, cols: number, rows: number) => void;
      openFileDialog: () => Promise<string | null>;
    };
  }
}

// ---- Catppuccin Mocha theme ----
const THEME = {
  background: '#1e1e2e', foreground: '#cdd6f4',
  cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
  selectionBackground: 'rgba(203,166,247,0.3)',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

// ---- State ----

interface TabSession {
  id: number;
  ptyId: number | null;
  term: Terminal;
  fitAddon: FitAddon;
  pane: HTMLElement;
  tabEl: HTMLElement;
  title: string;
  removeDataListener: (() => void) | null;
  removeExitListener: (() => void) | null;
  isSsh?: boolean;
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

function createTerminal(): { term: Terminal; fitAddon: FitAddon } {
  const term = new Terminal({
    fontFamily: '"Cascadia Code", "Cascadia Mono", "MS Gothic", "BIZ UDGothic", "Noto Sans Mono CJK JP", Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    theme: THEME,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    windowsMode: false,
    convertEol: false,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  return { term, fitAddon };
}

// ---- Clipboard helpers ----

function attachClipboard(pane: HTMLElement, term: Terminal, session: TabSession): void {
  // 選択 → 自動コピー
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });

  // 右クリック → ペースト
  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (session.ptyId === null) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) window.electronAPI.sendInput(session.ptyId, text);
    } catch {}
  });
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
  const { term, fitAddon } = createTerminal();
  term.open(pane);

  // Build tab element — insert before the new-tab-wrap
  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = String(tabId);
  tabEl.innerHTML = `
    <span class="tab-title">Terminal ${tabId}</span>
    <span class="tab-close" data-close="${tabId}">&#10005;</span>
  `;
  tabbar.insertBefore(tabEl, newTabWrap);

  const session: TabSession = {
    id: tabId, ptyId: null, term, fitAddon,
    pane, tabEl, title: `Terminal ${tabId}`,
    removeDataListener: null, removeExitListener: null,
    minimapActivityMap: null,
    minimapVirtualWidth: 0,
    minimapScrollX: 0,
  };
  sessions.set(tabId, session);
  attachClipboard(pane, term, session);

  activateTab(tabId);
  fitAddon.fit();

  // Connect to PTY
  try {
    const result = await window.electronAPI.createPty({
      shell: shellExe,
      cols: term.cols,
      rows: term.rows,
    });

    session.ptyId = result.id;

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

    term.onData((data: string) => {
      if (session.ptyId !== null) window.electronAPI.sendInput(result.id, data);
    });
    term.onResize(({ cols, rows }) => {
      if (session.ptyId !== null) window.electronAPI.resize(result.id, cols, rows);
    });
    term.onTitleChange((title: string) => {
      if (title) setTabTitle(session, title);
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
  if (session.ptyId !== null) {
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

// ---- Window controls ----

document.getElementById('btn-minimize')!.addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('btn-maximize')!.addEventListener('click', () => window.electronAPI.maximize());
document.getElementById('btn-close')!.addEventListener('click',   () => window.electronAPI.close());

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    openShellPicker();
    return;
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (activeTabId !== -1) closeTab(activeTabId);
    return;
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = [...sessions.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeTabId);
    activateTab(e.shiftKey
      ? ids[(idx - 1 + ids.length) % ids.length]
      : ids[(idx + 1) % ids.length]
    );
    return;
  }
  // 仮想幅 Ctrl+Shift+→/←/0
  if (e.ctrlKey && e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault();
    minimap.adjustVirtualWidth(40);
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    minimap.adjustVirtualWidth(-40);
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === '0') {
    e.preventDefault();
    minimap.resetVirtualWidth();
    return;
  }
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    const ids = [...sessions.keys()];
    const idx = parseInt(e.key) - 1;
    if (idx < ids.length) { e.preventDefault(); activateTab(ids[idx]); }
  }
});

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

  const { term, fitAddon } = createTerminal();
  // term.open() は activateTab() でペインが表示された後に呼ぶ
  // (display:none 状態で open すると xterm.js が文字幅を測定できず cols が狂う)

  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = String(tabId);
  tabEl.innerHTML = `
    <span class="tab-title">🔐 ${escapeHtml(profile.label)}</span>
    <span class="tab-close" data-close="${tabId}">&#10005;</span>
  `;
  tabbar.insertBefore(tabEl, newTabWrap);

  const session: TabSession = {
    id: tabId, ptyId: null, term, fitAddon,
    pane, tabEl, title: profile.label,
    removeDataListener: null, removeExitListener: null,
    isSsh: true,
    minimapActivityMap: null,
    minimapVirtualWidth: 0,
    minimapScrollX: 0,
  };
  sessions.set(tabId, session);

  // ペインを表示状態にしてから open — 正しい文字幅測定のため
  activateTab(tabId);
  term.open(pane);
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

    term.onData((data: string) => {
      if (session.ptyId !== null) window.electronAPI.sendInput(result.id, data);
    });
    term.onResize(({ cols, rows }) => {
      if (session.ptyId !== null) window.electronAPI.sshResize(result.id, cols, rows);
    });
    // 接続確立後に改めてリサイズを通知（RAF中に取得できなかった場合の保険）
    window.electronAPI.sshResize(result.id, term.cols, term.rows);

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

// ---- Boot ----

async function init(): Promise<void> {
  const { shells, defaultId } = await window.electronAPI.listShells();
  availableShells = shells;
  defaultShellId = defaultId;

  if (shells.length === 0) {
    // Fallback if detection completely fails
    await createTab();
    return;
  }

  // Open first tab with default shell
  const def = shells.find(s => s.id === defaultId) ?? shells[0];
  await createTab(def.exe);
}

init();
