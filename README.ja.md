# infiniterm

クロスプラットフォーム対応の Electron ターミナルエミュレーター。タブ管理、テーマ、SSH、ターミナル共有、スマホからのブラウザアクセスなど多機能。

## 主な機能

- **タブ管理** — 複数のシェルセッションをタブで切り替え
- **シェル自動検出** — macOS (zsh, bash, fish)、Windows (MSYS2 zsh/bash, PowerShell, CMD) を自動検出
- **SSH クライアント** — プロファイル管理、パスワード/鍵認証、接続履歴
- **テーマ** — Catppuccin Mocha (デフォルト), Catppuccin Latte, Dracula, Nord, Tokyo Night
- **ミニマップ** — ターミナル活動をヒートマップで可視化、横スクロール対応
- **ターミナル共有** — 同一ネットワーク上の他の infiniterm インスタンスとセッションを共有
- **Web ターミナル** — スマートフォンのブラウザからターミナルにアクセス (QR コード接続)
- **国際化** — 日本語/英語 UI
- **検索** — ターミナル内テキスト検索
- **ファイルリンク** — パスをクリックしてエディタで開く (VS Code, Cursor, Emacs, Vim, Sublime)

## Web ターミナル (モバイル対応)

スマートフォンのブラウザからターミナルを操作できます。

### 接続方法

1. 設定画面から Web ターミナルを開始
2. 表示される QR コードをスマートフォンで読み取り
3. Basic 認証でログイン (ユーザー名: `infiniterm`、パスワードは自動生成)

Tailscale ネットワークがある場合は自動検出され、Tailscale IP 経由での接続も可能です。

### モバイル UI

**ヘッダーバー** (常時表示):

| ボタン | 機能 |
|--------|------|
| ≡ | メニュー (Reconnect, Wake Lock, 画面回転ロック) |
| CP | コピー (選択テキスト) |
| PT | ペースト (クリップボードから入力) |
| A−/A+ | フォントサイズ変更 |
| −/+ | 仮想横幅の縮小/拡張 (100%〜) |

**コントロールキーバー** (キーボード表示時):

```
ESC  /  -  HOME  ↑  END  PGUP
TAB  CTRL  ALT  ←  ↓  →  PGDN
```

- CTRL / ALT はスティッキー修飾キー (タップ → 英字キーで Ctrl+文字)

**タッチ操作**:

- 上下スワイプ — 通常バッファ: スクロールバック / tmux: ペイン内スクロール
- 横スワイプ — 仮想横幅拡張時の横スクロール

**ヒートマップ** — 画面下部に 3px の活動度ヒートマップを表示

## キーボードショートカット

| ショートカット | 動作 |
|--------------|------|
| `Ctrl+T` | シェルピッカーを開く |
| `Ctrl+W` | 現在のタブを閉じる |
| `Ctrl+Tab` | 次のタブへ |
| `Ctrl+Shift+Tab` | 前のタブへ |
| `Ctrl+1` 〜 `Ctrl+9` | タブ番号で切り替え |
| `Ctrl+Shift+F` | 検索 |
| `Ctrl+=` | ズームイン |
| `Ctrl+-` | ズームアウト |
| `Ctrl+0` | ズームリセット |
| `F11` | フルスクリーン |
| `Ctrl+Shift+→/←` | ターミナル幅の拡張/縮小 |

## 対応シェル

### macOS / Linux

zsh, bash, fish, sh (標準パス + Homebrew から自動検出)

### Windows

| シェル | 検出パス |
|--------|---------|
| zsh (MSYS2) | `C:\msys64\usr\bin\zsh.exe` など |
| bash (MSYS2) | `C:\msys64\usr\bin\bash.exe` など |
| PowerShell 7 | `C:\Program Files\PowerShell\7\pwsh.exe` |
| PowerShell 5 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| Command Prompt | `%COMSPEC%` |

## 開発

### セットアップ

```bash
npm run setup
```

### ビルド & 起動

```bash
npm run build   # TypeScript + webpack コンパイル
npm start       # ビルド後に起動
```

### パッケージング

```bash
npm run package      # 現在のプラットフォーム向け
npm run package:mac  # macOS DMG
npm run package:win  # Windows インストーラー + ポータブル
```

### 技術スタック

| コンポーネント | ライブラリ |
|-------------|---------|
| アプリフレーム | Electron 28 |
| 言語 | TypeScript |
| ターミナル UI | xterm.js v5 |
| PTY | @homebridge/node-pty-prebuilt-multiarch |
| SSH | ssh2 |
| WebSocket | ws |
| QR コード | qrcode |
| バンドラ | webpack 5 |

## ライセンス

MIT
