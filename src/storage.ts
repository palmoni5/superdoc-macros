/**
 * שמירת המאקרו, ההקלטות והקטעים. ברירת המחדל: localStorage; הממשק ניתן
 * להחלפה כדי שמארח יוכל לשמור בקובץ (למשל ב-workspace של תוסף אוצריא).
 */
import type { RecordedMacro, SavedScript, Snippet } from './types.js';

export interface PersistedMacroState {
  version: 1;
  scripts: SavedScript[];
  recordings: RecordedMacro[];
  snippets: Snippet[];
}

export interface MacroStorage {
  /** `null` כשאין מצב שמור או כשהשמור אינו קריא. */
  load(): PersistedMacroState | null;
  save(state: PersistedMacroState): void;
}

export function emptyState(): PersistedMacroState {
  return { version: 1, scripts: [], recordings: [], snippets: [] };
}

function isValidState(value: unknown): value is PersistedMacroState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    Array.isArray(state.scripts) &&
    Array.isArray(state.recordings) &&
    Array.isArray(state.snippets)
  );
}

/** מפענחת מצב שמור. `null` על כל צורה לא צפויה — לא זורקת. */
export function parsePersistedState(json: string): PersistedMacroState | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const DEFAULT_STORAGE_KEY = 'superdoc-macros:v1';

/** localStorage עם הגנות: גישה חסומה או מלאה אינה מפילה את הערכה. */
export function createLocalStorage(
  key: string = DEFAULT_STORAGE_KEY,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): MacroStorage {
  const backing = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
    if (storage) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };

  return {
    load() {
      try {
        const raw = backing()?.getItem(key);
        return raw ? parsePersistedState(raw) : null;
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        backing()?.setItem(key, JSON.stringify(state));
      } catch (error) {
        console.warn('[superdoc-macros] שמירת המאקרו נכשלה', error);
      }
    },
  };
}

/** אחסון בזיכרון — לבדיקות ולמצבים שבהם אין persistence. */
export function createMemoryStorage(): MacroStorage {
  let saved: PersistedMacroState | null = null;
  return {
    load: () => (saved ? (JSON.parse(JSON.stringify(saved)) as PersistedMacroState) : null),
    save(state) {
      saved = JSON.parse(JSON.stringify(state)) as PersistedMacroState;
    },
  };
}
