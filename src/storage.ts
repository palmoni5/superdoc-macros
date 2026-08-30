/**
 * Persistence for macros, recordings and snippets. Default: localStorage;
 * the interface is swappable so a host can persist to a file (e.g. a
 * plugin workspace).
 */
import type { RecordedMacro, SavedScript, Snippet } from './types.js';

export interface PersistedMacroState {
  version: 1;
  scripts: SavedScript[];
  recordings: RecordedMacro[];
  snippets: Snippet[];
}

export interface MacroStorage {
  /** `null` when there is no saved state or the saved state is unreadable. */
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

/** Parses saved state. `null` on any unexpected shape — never throws. */
export function parsePersistedState(json: string): PersistedMacroState | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const DEFAULT_STORAGE_KEY = 'superdoc-macros:v1';

/** localStorage with guards: blocked or full storage must not take the toolkit down. */
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
        console.warn('[superdoc-macros] saving macros failed', error);
      }
    },
  };
}

/** In-memory storage — for tests and for setups with no persistence. */
export function createMemoryStorage(): MacroStorage {
  let saved: PersistedMacroState | null = null;
  return {
    load: () => (saved ? (JSON.parse(JSON.stringify(saved)) as PersistedMacroState) : null),
    save(state) {
      saved = JSON.parse(JSON.stringify(state)) as PersistedMacroState;
    },
  };
}
