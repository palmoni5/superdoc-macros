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
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
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

export function eventMatches(parsed: ParsedShortcut, event: KeyEventLike): boolean {
  if (normalizeKey(event.key) !== parsed.key) return false;

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
