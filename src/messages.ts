/**
 * All user-facing runtime strings, in one place.
 *
 * The toolkit reports failures to end users (status bars, dialogs), so the
 * strings are part of the product, not debug output. Defaults are English;
 * a host with a localized UI swaps them once at startup:
 *
 * ```ts
 * import { setMacroMessages, HEBREW_MESSAGES } from 'superdoc-macros';
 * setMacroMessages(HEBREW_MESSAGES);
 * ```
 *
 * A module-level locale rather than per-instance options, deliberately: the
 * strings surface from many layers (API, runners, host adapter, manager),
 * and threading an options object through all of them would make every
 * factory signature about localization. One UI language per page is the
 * reality these editors live in.
 */

export interface MacroMessages {
  /* Script API */
  unknownMethod: (method: string) => string;
  mustBeString: (name: string) => string;
  commandFailed: (id: string) => string;
  insertTextFailed: string;
  insertParagraphFailed: string;
  deleteFailed: string;
  replaceFailed: string;

  /* Runners */
  syntaxError: (detail: string) => string;
  timedOut: (seconds: number) => string;
  callLimitExceeded: (limit: number) => string;
  macroStopped: string;

  /* Manager */
  scriptNotFound: string;
  recordingNotFound: string;
  snippetNotFound: string;
  cannotRunWhileRecording: string;
  anotherMacroRunning: string;
  invalidImport: string;

  /* Shortcut validation */
  shortcutInvalid: string;
  shortcutNeedsModifier: string;
  shortcutReserved: string;
  shortcutTaken: (ownerName: string) => string;

  /* SuperDoc host adapter */
  noDocument: string;
  selectionUnavailable: string;
  unknownCommand: (id: string) => string;
  actionFailed: string;
  deletionUnavailable: string;
  searchUnavailable: string;
  searchUnavailableInDocument: string;
}

export const ENGLISH_MESSAGES: MacroMessages = {
  unknownMethod: (method) => `Unknown method: ${method}`,
  mustBeString: (name) => `${name} must be a string`,
  commandFailed: (id) => `Command ${id} failed`,
  insertTextFailed: 'Failed to insert text',
  insertParagraphFailed: 'Failed to insert paragraph',
  deleteFailed: 'Delete failed',
  replaceFailed: 'Replace failed',

  syntaxError: (detail) => `Macro syntax error: ${detail}`,
  timedOut: (seconds) => `The macro did not finish within ${seconds} seconds and was stopped`,
  callLimitExceeded: (limit) => `The macro exceeded the API call limit (${limit}) and was stopped`,
  macroStopped: 'The macro was stopped — the call was not executed',

  scriptNotFound: 'Macro not found',
  recordingNotFound: 'Recording not found',
  snippetNotFound: 'Snippet not found',
  cannotRunWhileRecording: 'Cannot run a macro while recording',
  anotherMacroRunning: 'Another macro is still running',
  invalidImport: 'The file is not a valid macro export',

  shortcutInvalid: 'Invalid shortcut — use a form like Ctrl+Alt+M',
  shortcutNeedsModifier: 'A shortcut must include Ctrl, Alt or Meta',
  shortcutReserved: 'This shortcut is reserved by the editor',
  shortcutTaken: (ownerName) => `This shortcut is already used by "${ownerName}"`,

  noDocument: 'No document is open',
  selectionUnavailable: 'The caret position could not be read — nothing was inserted',
  unknownCommand: (id) => `The engine does not recognize the command ${id}`,
  actionFailed: 'The operation failed',
  deletionUnavailable: 'Deletion is not available in this document',
  searchUnavailable: 'Search is not available',
  searchUnavailableInDocument: 'Search is not available in this document',
};

/** Hebrew locale — the strings the toolkit shipped with originally. */
export const HEBREW_MESSAGES: MacroMessages = {
  unknownMethod: (method) => `מתודה לא מוכרת: ${method}`,
  mustBeString: (name) => `${name} חייב להיות מחרוזת`,
  commandFailed: (id) => `הפקודה ${id} נכשלה`,
  insertTextFailed: 'הכנסת הטקסט נכשלה',
  insertParagraphFailed: 'הכנסת הפסקה נכשלה',
  deleteFailed: 'המחיקה נכשלה',
  replaceFailed: 'ההחלפה נכשלה',

  syntaxError: (detail) => `שגיאת תחביר במאקרו: ${detail}`,
  timedOut: (seconds) => `המאקרו לא הסתיים תוך ${seconds} שניות ונעצר`,
  callLimitExceeded: (limit) => `המאקרו חצה את תקרת הקריאות (${limit}) ונעצר`,
  macroStopped: 'המאקרו נעצר — הקריאה לא בוצעה',

  scriptNotFound: 'המאקרו לא נמצא',
  recordingNotFound: 'ההקלטה לא נמצאה',
  snippetNotFound: 'הקטע לא נמצא',
  cannotRunWhileRecording: 'אי אפשר להריץ מאקרו בזמן הקלטה',
  anotherMacroRunning: 'מאקרו אחר עדיין רץ',
  invalidImport: 'הקובץ אינו ייצוא מאקרו תקין',

  shortcutInvalid: 'קיצור לא תקין — הצורה הנדרשת היא למשל Ctrl+Alt+M',
  shortcutNeedsModifier: 'קיצור חייב לכלול Ctrl,‏ Alt או Meta',
  shortcutReserved: 'הקיצור הזה שמור לעורך',
  shortcutTaken: (ownerName) => `הקיצור כבר בשימוש של "${ownerName}"`,

  noDocument: 'אין מסמך פתוח',
  selectionUnavailable: 'קריאת מיקום הסמן נכשלה — לא הוכנס דבר',
  unknownCommand: (id) => `הפקודה ${id} אינה מוכרת למנוע`,
  actionFailed: 'הפעולה נכשלה',
  deletionUnavailable: 'מחיקה אינה זמינה במסמך הזה',
  searchUnavailable: 'החיפוש אינו זמין',
  searchUnavailableInDocument: 'החיפוש אינו זמין במסמך הזה',
};

let current: MacroMessages = { ...ENGLISH_MESSAGES };

/** Replaces some or all runtime strings. Call once, before creating hosts/kits. */
export function setMacroMessages(messages: Partial<MacroMessages>): void {
  current = { ...current, ...messages };
}

/** The active locale. Internal — modules read strings through this. */
export function macroMessages(): MacroMessages {
  return current;
}
