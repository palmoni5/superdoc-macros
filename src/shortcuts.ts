/**
 * Keyboard shortcuts for macros and snippets: parsing a `Ctrl+Alt+M` string
 * and matching it against an event.
 *
 * Matching is by lowercased `event.key`. `Mod` means Ctrl (or ⌘ on macOS).
 */
export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Ctrl or Meta — for shortcuts written with `Mod`. */
  mod: boolean;
}

/** The subset of KeyboardEvent that matching needs. Enables DOM-free tests. */
export interface KeyEventLike {
  key: string;
  /** The physical key. When present, letters and digits match by it — see `eventMatches`. */
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** Key held down — auto-repeat must not re-fire a macro. */
  repeat?: boolean;
  /** Mid-IME-composition — keys belong to the composition, not to bindings. */
  isComposing?: boolean;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const parsed: ParsedShortcut = { key: '', ctrl: false, alt: false, shift: false, meta: false, mod: false };

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'ctrl':
      case 'control':
        parsed.ctrl = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
      case 'meta':
      case 'cmd':
      case 'win':
        parsed.meta = true;
        break;
      case 'mod':
        parsed.mod = true;
        break;
      default: {
        if (parsed.key) return null; // two non-modifier keys — an invalid shortcut.
        parsed.key = normalizeKey(part);
      }
    }
  }

  return parsed.key ? parsed : null;
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower === 'space') return ' ';
  if (lower === 'esc') return 'escape';
  return lower;
}

/**
 * The physical `event.code` values a binding key stands for. Letters and
 * digits get a deterministic mapping; anything else returns empty and falls
 * back to `event.key`.
 *
 * Physical-key matching is what keeps a binding alive across keyboard
 * layouts: on a Hebrew layout Ctrl+Alt+R reports `key: 'ר'`, and a
 * key-based match would die the moment the user switches to Hebrew — the
 * exact bug the host editor once had with its own shortcuts.
 */
export function codesForKey(key: string): readonly string[] {
  if (/^[a-z]$/.test(key)) return [`Key${key.toUpperCase()}`];
  if (/^[0-9]$/.test(key)) return [`Digit${key}`, `Numpad${key}`];
  if (/^f([1-9]|1[0-2])$/.test(key)) return [key.toUpperCase()];
  if (key === ' ') return ['Space'];
  if (key === 'escape') return ['Escape'];
  return [];
}

/** Whether the key can be bound reliably (has a physical-code mapping). */
export function isBindableKey(parsed: ParsedShortcut): boolean {
  return codesForKey(parsed.key).length > 0;
}

export function eventMatches(parsed: ParsedShortcut, event: KeyEventLike): boolean {
  const codes = codesForKey(parsed.key);
  const keyMatched = normalizeKey(event.key) === parsed.key;
  // The physical code decides whenever both sides have one; `event.key` is
  // the fallback for keys with no mapping or hosts that do not report codes.
  const matched =
    codes.length > 0 && event.code !== undefined ? codes.includes(event.code) : keyMatched;
  if (!matched) return false;

  if (parsed.mod) {
    if (!event.ctrlKey && !event.metaKey) return false;
    // With Mod, ctrl/meta are not checked individually — but alt/shift must match exactly.
    return event.altKey === parsed.alt && event.shiftKey === parsed.shift;
  }

  return (
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    event.metaKey === parsed.meta
  );
}

/**
 * Comparable signatures for collision checks. `Mod` matches either Ctrl or
 * Meta at runtime, so it expands to both — a `Mod+K` binding collides with
 * `Ctrl+K` and with `Meta+K`.
 */
export function shortcutSignatures(parsed: ParsedShortcut): string[] {
  const suffix = `${parsed.alt ? 'alt+' : ''}${parsed.shift ? 'shift+' : ''}${parsed.key}`;
  if (parsed.mod) return [`ctrl+${suffix}`, `meta+${suffix}`];
  return [`${parsed.ctrl ? 'ctrl+' : ''}${parsed.meta ? 'meta+' : ''}${suffix}`];
}

/**
 * Whether the shortcut is acceptable as a *saved binding*: it must carry a
 * real modifier (Ctrl/Alt/Meta/Mod). A bare letter would fire on ordinary
 * typing, and Shift alone is just an uppercase letter.
 */
export function hasBindingModifier(parsed: ParsedShortcut): boolean {
  return parsed.ctrl || parsed.alt || parsed.meta || parsed.mod;
}

export interface ShortcutBinding {
  shortcut: string;
  run(): void | Promise<unknown>;
}

export interface ShortcutTarget {
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, options?: boolean): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, options?: boolean): void;
}

/**
 * Binds shortcuts to a target. `getBindings` is called on every keystroke —
 * so the macro list can change without rebinding. Returns a dispose
 * function.
 */
export function bindShortcuts(target: ShortcutTarget, getBindings: () => readonly ShortcutBinding[]): () => void {
  const listener = (event: KeyboardEvent): void => {
    // Auto-repeat must not replay a macro per repeat tick, and keys mid-IME
    // composition belong to the composition.
    if (event.repeat || event.isComposing) return;
    for (const binding of getBindings()) {
      const parsed = parseShortcut(binding.shortcut);
      if (!parsed || !eventMatches(parsed, event)) continue;
      event.preventDefault?.();
      event.stopPropagation?.();
      void binding.run();
      return;
    }
  };

  target.addEventListener('keydown', listener, true);
  return () => target.removeEventListener('keydown', listener, true);
}
