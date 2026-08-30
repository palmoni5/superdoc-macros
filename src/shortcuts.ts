/**
 * קיצורי מקלדת למאקרו ולקטעים: ניתוח מחרוזת `Ctrl+Alt+M` והתאמה לאירוע.
 *
 * ההתאמה לפי `event.key` באותיות קטנות. `Mod` פירושו Ctrl (או ⌘ במק).
 */
export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Ctrl או Meta — לקיצורים שנכתבו עם `Mod`. */
  mod: boolean;
}

/** תת-הצורה של KeyboardEvent שההתאמה צריכה. מאפשר בדיקות בלי DOM. */
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
        if (parsed.key) return null; // שני מקשים שאינם modifiers — קיצור פסול.
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
    // עם Mod לא בודקים ctrl/meta בנפרד — אבל alt/shift חייבים להתאים בדיוק.
    return event.altKey === parsed.alt && event.shiftKey === parsed.shift;
  }

  return (
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    event.metaKey === parsed.meta
  );
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
 * קושרת קיצורים ליעד. `getBindings` נקראת בכל הקשה — כך רשימת המאקרו יכולה
 * להשתנות בלי לקשור מחדש. מחזירה פונקציית ניתוק.
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
