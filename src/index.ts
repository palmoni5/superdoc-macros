export type {
  MacroHost,
  MacroOutcome,
  MacroStep,
  RecordedMacro,
  SavedScript,
  SelectionSnapshot,
  Snippet,
  TextInputEvent,
} from './types.js';

export { MacroKit, type MacroKitOptions } from './manager.js';

export {
  ENGLISH_MESSAGES,
  HEBREW_MESSAGES,
  setMacroMessages,
  type MacroMessages,
} from './messages.js';

export { createSuperdocHost, type SuperdocHostOptions, type SuperdocLike, type SuperdocMacroHost } from './host/superdoc-host.js';

export { createMacroApi, MacroError, type MacroApi, type MacroBridge, type ScriptSelection } from './scripting/macro-api.js';
export { createEvalRunner } from './scripting/eval-runner.js';
export { createIframeRunner, SANDBOX_BOOTSTRAP, isProtocolMessage } from './scripting/iframe-runner.js';
export type { MacroRunner, MacroRunOptions, MacroRunResult } from './scripting/runner.js';

export { MacroRecorder, replayMacro, type RecorderOptions, type ReplayOptions, type ReplayResult } from './recorder/recorder.js';

export { renderSnippet, expandSnippet, usesSelection, type ExpandOptions, type RenderContext } from './snippets/snippets.js';
export { AutoText, type AutoTextOptions } from './snippets/autotext.js';

export { parseShortcut, eventMatches, bindShortcuts, type ParsedShortcut, type ShortcutBinding, type ShortcutTarget } from './shortcuts.js';

export {
  createLocalStorage,
  createMemoryStorage,
  emptyState,
  parsePersistedState,
  DEFAULT_STORAGE_KEY,
  type MacroStorage,
  type PersistedMacroState,
} from './storage.js';
