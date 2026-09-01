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

export { MacroKit, type MacroKitOptions, type ShortcutValidation } from './manager.js';

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

export {
  MacroRecorder,
  replayMacro,
  type RecorderOptions,
  type RecordingWarning,
  type ReplayOptions,
  type ReplayResult,
} from './recorder/recorder.js';

export {
  renderSnippet,
  renderSnippetForHost,
  expandSnippet,
  usesSelection,
  type ExpandOptions,
  type RenderContext,
} from './snippets/snippets.js';
export { AutoText, type AutoTextOptions, type AutoTextExpansion } from './snippets/autotext.js';

export {
  parseShortcut,
  eventMatches,
  bindShortcuts,
  shortcutSignatures,
  hasBindingModifier,
  isBindableKey,
  codesForKey,
  type ParsedShortcut,
  type ShortcutBinding,
  type ShortcutTarget,
} from './shortcuts.js';

/**
 * Reading the VBA macros already inside a `.docm`, for review only. Separate
 * from `MacroKit` on purpose: extraction touches no saved macro, binds no
 * shortcut, and executes nothing — see `src/import/vba.ts`.
 */
export {
  extractVbaFromDocx,
  extractVbaProject,
  findVbaPart,
  scanForAutoRunProcedures,
  VBA_LIMITS,
  type VbaExtraction,
  type VbaFailureReason,
  type VbaModule,
  type VbaModuleKind,
  type VbaProcedureRef,
  type VbaProject,
  type VbaWarning,
} from './import/vba.js';
export { VbaParseError, isVbaParseError, type VbaParseErrorCode } from './import/errors.js';
export { readCfb, CFB_LIMITS, type CfbContainer, type CfbEntry, type CfbEntryType } from './import/cfb.js';
export { openZip, ZIP_LIMITS, type ZipArchive, type ZipEntry } from './import/zip.js';
export { decompressOvba, OVBA_LIMITS, type DecompressOvbaOptions } from './import/ms-ovba.js';

export {
  createLocalStorage,
  createMemoryStorage,
  emptyState,
  parsePersistedState,
  DEFAULT_STORAGE_KEY,
  IMPORT_LIMITS,
  isPersistableState,
  serializePersistable,
  type MacroStorage,
  type PersistedMacroState,
} from './storage.js';
