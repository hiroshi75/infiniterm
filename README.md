# infiniterm

A cross-platform Electron terminal emulator with tab management, themes, SSH, terminal sharing, and mobile browser access.

[日本語](README.ja.md)

## Features

- **Tab management** — Switch between multiple shell sessions with tabs
- **Shell auto-detection** — Automatically detects macOS (zsh, bash, fish) and Windows (MSYS2 zsh/bash, PowerShell, CMD)
- **SSH client** — Profile management, password/key authentication, connection history
- **Themes** — Catppuccin Mocha (default), Catppuccin Latte, Dracula, Nord, Tokyo Night
- **Minimap** — Visualize terminal activity as a heatmap with horizontal scroll support
- **Terminal sharing** — Share sessions with other infiniterm instances on the same network
- **Web terminal** — Access your terminal from a smartphone browser (QR code connection)
- **i18n** — Japanese / English UI
- **Search** — In-terminal text search
- **File links** — Click paths to open in your editor (VS Code, Cursor, Emacs, Vim, Sublime)

## Web Terminal (Mobile Support)

Control your terminal from a smartphone browser.

### How to Connect

1. Start the web terminal from the settings screen
2. Scan the displayed QR code with your smartphone
3. Log in with Basic authentication (username: `infiniterm`, password is auto-generated)

If a Tailscale network is available, it will be auto-detected and connection via Tailscale IP is also supported.

### Mobile UI

**Header bar** (always visible):

| Button | Function |
|--------|----------|
| ≡ | Menu (Reconnect, Wake Lock, Screen rotation lock) |
| CP | Copy (selected text) |
| PT | Paste (input from clipboard) |
| A−/A+ | Change font size |
| −/+ | Shrink/expand virtual width (100%~) |

**Control key bar** (visible when keyboard is open):

```
ESC  /  -  HOME  ↑  END  PGUP
TAB  CTRL  ALT  ←  ↓  →  PGDN
```

- CTRL / ALT are sticky modifier keys (tap → press a letter key for Ctrl+key)

**Touch gestures**:

- Vertical swipe — Normal buffer: scrollback / tmux: scroll within pane
- Horizontal swipe — Horizontal scroll when virtual width is expanded

**Heatmap** — A 3px activity heatmap is displayed at the bottom of the screen

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | Open shell picker |
| `Ctrl+W` | Close current tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+1` – `Ctrl+9` | Switch to tab by number |
| `Ctrl+Shift+F` | Search |
| `Ctrl+=` | Zoom in |
| `Ctrl+-` | Zoom out |
| `Ctrl+0` | Reset zoom |
| `F11` | Fullscreen |
| `Ctrl+Shift+→/←` | Expand/shrink terminal width |

## Supported Shells

### macOS / Linux

zsh, bash, fish, sh (auto-detected from standard paths + Homebrew)

### Windows

| Shell | Detection Path |
|-------|---------------|
| zsh (MSYS2) | `C:\msys64\usr\bin\zsh.exe` etc. |
| bash (MSYS2) | `C:\msys64\usr\bin\bash.exe` etc. |
| PowerShell 7 | `C:\Program Files\PowerShell\7\pwsh.exe` |
| PowerShell 5 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| Git Bash | `C:\Program Files\Git\bin\bash.exe` |
| Command Prompt | `%COMSPEC%` |

## Development

### Setup

```bash
npm run setup
```

### Build & Run

```bash
npm run build   # Compile TypeScript + webpack
npm start       # Run after build
```

### Packaging

```bash
npm run package      # For current platform
npm run package:mac  # macOS DMG
npm run package:win  # Windows installer + portable
```

### Tech Stack

| Component | Library |
|-----------|---------|
| App framework | Electron 28 |
| Language | TypeScript |
| Terminal UI | xterm.js v5 |
| PTY | @homebridge/node-pty-prebuilt-multiarch |
| SSH | ssh2 |
| WebSocket | ws |
| QR code | qrcode |
| Bundler | webpack 5 |

## License

MIT
