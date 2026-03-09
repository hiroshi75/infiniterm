export interface InfinitermTheme {
  label: string;
  terminal: {
    background: string; foreground: string;
    cursor: string; cursorAccent: string;
    selectionBackground: string;
    black: string; red: string; green: string; yellow: string;
    blue: string; magenta: string; cyan: string; white: string;
    brightBlack: string; brightRed: string; brightGreen: string;
    brightYellow: string; brightBlue: string; brightMagenta: string;
    brightCyan: string; brightWhite: string;
  };
  ui: {
    bgBase: string; bgMantle: string;
    bgSurface: string; bgSurface1: string;
    fgBase: string; fgSub: string;
    accent: string; red: string; green: string; yellow: string;
  };
}

export const THEMES: Record<string, InfinitermTheme> = {
  'catppuccin-mocha': {
    label: 'Catppuccin Mocha',
    terminal: {
      background: '#1e1e2e', foreground: '#cdd6f4',
      cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
      selectionBackground: 'rgba(203,166,247,0.3)',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
    ui: {
      bgBase: '#1e1e2e', bgMantle: '#181825',
      bgSurface: '#313244', bgSurface1: '#45475a',
      fgBase: '#cdd6f4', fgSub: '#a6adc8',
      accent: '#89b4fa', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    },
  },
  'catppuccin-latte': {
    label: 'Catppuccin Latte',
    terminal: {
      background: '#eff1f5', foreground: '#4c4f69',
      cursor: '#dc8a78', cursorAccent: '#eff1f5',
      selectionBackground: 'rgba(136,57,239,0.2)',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
      blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
      brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb',
      brightCyan: '#179299', brightWhite: '#bcc0cc',
    },
    ui: {
      bgBase: '#eff1f5', bgMantle: '#e6e9ef',
      bgSurface: '#ccd0da', bgSurface1: '#bcc0cc',
      fgBase: '#4c4f69', fgSub: '#6c6f85',
      accent: '#1e66f5', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    },
  },
  'dracula': {
    label: 'Dracula',
    terminal: {
      background: '#282a36', foreground: '#f8f8f2',
      cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: 'rgba(68,71,90,0.5)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    ui: {
      bgBase: '#282a36', bgMantle: '#21222c',
      bgSurface: '#44475a', bgSurface1: '#6272a4',
      fgBase: '#f8f8f2', fgSub: '#bfbfbf',
      accent: '#bd93f9', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    },
  },
  'nord': {
    label: 'Nord',
    terminal: {
      background: '#2e3440', foreground: '#d8dee9',
      cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: 'rgba(136,192,208,0.3)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8be9fd', brightWhite: '#eceff4',
    },
    ui: {
      bgBase: '#2e3440', bgMantle: '#272c36',
      bgSurface: '#3b4252', bgSurface1: '#434c5e',
      fgBase: '#d8dee9', fgSub: '#a0a8b7',
      accent: '#88c0d0', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    },
  },
  'tokyo-night': {
    label: 'Tokyo Night',
    terminal: {
      background: '#1a1b26', foreground: '#c0caf5',
      cursor: '#c0caf5', cursorAccent: '#1a1b26',
      selectionBackground: 'rgba(40,52,94,0.6)',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
      brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
    ui: {
      bgBase: '#1a1b26', bgMantle: '#16161e',
      bgSurface: '#292e42', bgSurface1: '#3b4261',
      fgBase: '#c0caf5', fgSub: '#565f89',
      accent: '#7aa2f7', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    },
  },
};

export interface AppSettings {
  theme: string;
  fontSize: number;
  fontFamily: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  windowOpacity: number;
  scrollback: number;
  cursorBlink: boolean;
  fileLinkEnabled: boolean;
  editor: string;
  language: string;
  tmuxPaneExpansion: 'equal' | 'left';
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'catppuccin-mocha',
  fontSize: 14,
  fontFamily: '"Cascadia Code", "Cascadia Mono", "Menlo", "SF Mono", "MS Gothic", "BIZ UDGothic", "Noto Sans Mono CJK JP", Consolas, monospace',
  cursorStyle: 'block',
  windowOpacity: 1.0,
  scrollback: 10000,
  cursorBlink: true,
  fileLinkEnabled: true,
  editor: 'auto',
  language: 'ja',
  tmuxPaneExpansion: 'equal',
};
