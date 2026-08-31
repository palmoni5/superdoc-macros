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

/**
 * Caps on imported data. Imports come from files users share with each
 * other, so every field is validated and bounded — a malformed or oversized
 * export must fail closed, not wedge the store or the UI.
 */
export const IMPORT_LIMITS = {
  /** Whole-file size, in UTF-16 code units of the JSON string. */
  maxJsonLength: 5_000_000,
  /** Per list: scripts, recordings, snippets. */
  maxItems: 500,
  maxStepsPerRecording: 5_000,
  maxNameLength: 200,
  maxShortcutLength: 60,
  maxTriggerLength: 60,
  /** Snippet text and single recorded insert-text step. */
  maxTextLength: 100_000,
  maxSourceLength: 200_000,
} as const;

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0);
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || boundedString(value, maxLength);
}

function isValidStep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  switch (step.type) {
    case 'command':
      // The payload is opaque engine data; the id is what replay dispatches on.
      return boundedString(step.id, IMPORT_LIMITS.maxNameLength);
    case 'insert-text':
      return boundedString(step.text, IMPORT_LIMITS.maxTextLength, true);
    case 'insert-paragraph':
      return true;
    case 'delete-backward':
    case 'delete-forward':
      return typeof step.count === 'number' && Number.isInteger(step.count) && step.count > 0 && step.count <= IMPORT_LIMITS.maxTextLength;
    default:
      return false;
  }
}

function isValidScript(value: unknown): value is SavedScript {
  if (typeof value !== 'object' || value === null) return false;
  const script = value as Record<string, unknown>;
  return (
    boundedString(script.id, IMPORT_LIMITS.maxNameLength) &&
    boundedString(script.name, IMPORT_LIMITS.maxNameLength) &&
    boundedString(script.source, IMPORT_LIMITS.maxSourceLength, true) &&
    optionalBoundedString(script.shortcut, IMPORT_LIMITS.maxShortcutLength)
  );
}

function isValidRecording(value: unknown): value is RecordedMacro {
  if (typeof value !== 'object' || value === null) return false;
  const recording = value as Record<string, unknown>;
  return (
    recording.version === 1 &&
    boundedString(recording.id, IMPORT_LIMITS.maxNameLength) &&
    boundedString(recording.name, IMPORT_LIMITS.maxNameLength) &&
    optionalBoundedString(recording.createdAt, IMPORT_LIMITS.maxNameLength) &&
    optionalBoundedString(recording.shortcut, IMPORT_LIMITS.maxShortcutLength) &&
    Array.isArray(recording.steps) &&
    recording.steps.length <= IMPORT_LIMITS.maxStepsPerRecording &&
    recording.steps.every(isValidStep)
  );
}

function isValidSnippet(value: unknown): value is Snippet {
  if (typeof value !== 'object' || value === null) return false;
  const snippet = value as Record<string, unknown>;
  return (
    boundedString(snippet.id, IMPORT_LIMITS.maxNameLength) &&
    boundedString(snippet.name, IMPORT_LIMITS.maxNameLength) &&
    boundedString(snippet.text, IMPORT_LIMITS.maxTextLength, true) &&
    optionalBoundedString(snippet.trigger, IMPORT_LIMITS.maxTriggerLength) &&
    optionalBoundedString(snippet.shortcut, IMPORT_LIMITS.maxShortcutLength)
  );
}

function isValidState(value: unknown): value is PersistedMacroState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    Array.isArray(state.scripts) &&
    state.scripts.length <= IMPORT_LIMITS.maxItems &&
    state.scripts.every(isValidScript) &&
    Array.isArray(state.recordings) &&
    state.recordings.length <= IMPORT_LIMITS.maxItems &&
    state.recordings.every(isValidRecording) &&
    Array.isArray(state.snippets) &&
    state.snippets.length <= IMPORT_LIMITS.maxItems &&
    state.snippets.every(isValidSnippet)
  );
}

/**
 * Parses saved/imported state. `null` on any unexpected shape, oversized
 * field or oversized file — never throws, never partially accepts: one
 * invalid item rejects the whole document, so the caller can tell the user
 * the file is bad instead of silently importing a subset.
 */
export function parsePersistedState(json: string): PersistedMacroState | null {
  if (json.length > IMPORT_LIMITS.maxJsonLength) return null;
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
