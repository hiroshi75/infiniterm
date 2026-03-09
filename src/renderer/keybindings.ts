// ---- Keybinding system ----

export interface ParsedBinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  code: string;
}

export interface CompiledAction {
  action: string;
  binding: ParsedBinding;
}

export const DEFAULT_KEYBINDINGS: Record<string, string | string[]> = {
  newTab: 'Ctrl+T',
  closeTab: 'Ctrl+W',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  search: 'Ctrl+Shift+F',
  zoomIn: ['Ctrl+=', 'Ctrl+Shift+='],
  zoomOut: 'Ctrl+-',
  zoomReset: 'Ctrl+0',
  fullscreen: 'F11',
  settings: 'Ctrl+Comma',
  expandWidth: 'Ctrl+Shift+ArrowRight',
  shrinkWidth: 'Ctrl+Shift+ArrowLeft',
  resetWidth: 'Ctrl+Shift+Backquote',
  scrollRight: 'Ctrl+Shift+Period',
  scrollLeft: 'Ctrl+Shift+Comma',
  scrollToEnd: 'Ctrl+Shift+L',
  scrollToStart: 'Ctrl+Shift+K',
  tab1: 'Ctrl+1',
  tab2: 'Ctrl+2',
  tab3: 'Ctrl+3',
  tab4: 'Ctrl+4',
  tab5: 'Ctrl+5',
  tab6: 'Ctrl+6',
  tab7: 'Ctrl+7',
  tab8: 'Ctrl+8',
  tab9: 'Ctrl+9',
};

function keyNameToCode(name: string): string {
  if (/^[a-zA-Z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;

  const map: Record<string, string> = {
    '=': 'Equal', '-': 'Minus', '+': 'Equal',
    '.': 'Period', ',': 'Comma', '/': 'Slash',
    ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
    '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
    'Space': 'Space', 'Enter': 'Enter', 'Escape': 'Escape',
    'Tab': 'Tab', 'Backspace': 'Backspace', 'Delete': 'Delete',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
    // Already code-format names
    'Period': 'Period', 'Comma': 'Comma', 'Equal': 'Equal', 'Minus': 'Minus',
    'Backquote': 'Backquote', 'Slash': 'Slash', 'Semicolon': 'Semicolon',
    'Quote': 'Quote', 'BracketLeft': 'BracketLeft', 'BracketRight': 'BracketRight',
  };

  if (/^F\d{1,2}$/.test(name)) return name;
  return map[name] ?? name;
}

export function parseKeyCombo(str: string): ParsedBinding {
  const parts = str.split('+').map(s => s.trim());
  const binding: ParsedBinding = { ctrl: false, shift: false, alt: false, meta: false, code: '' };
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case 'ctrl': binding.ctrl = true; break;
      case 'shift': binding.shift = true; break;
      case 'alt': binding.alt = true; break;
      case 'meta': case 'cmd': binding.meta = true; break;
      default: binding.code = keyNameToCode(p); break;
    }
  }
  return binding;
}

export function matchesBinding(e: KeyboardEvent, binding: ParsedBinding): boolean {
  return e.ctrlKey === binding.ctrl &&
    e.shiftKey === binding.shift &&
    e.altKey === binding.alt &&
    e.metaKey === binding.meta &&
    e.code === binding.code;
}

export function compileBindings(
  defaults: Record<string, string | string[]>,
  overrides: Record<string, string | string[]>,
): CompiledAction[] {
  const merged = { ...defaults, ...overrides };
  const result: CompiledAction[] = [];
  for (const [action, combo] of Object.entries(merged)) {
    const combos = Array.isArray(combo) ? combo : [combo];
    for (const c of combos) {
      result.push({ action, binding: parseKeyCombo(c) });
    }
  }
  return result;
}
