/**
 * החוזים המשותפים של הערכה.
 *
 * `MacroHost` הוא נקודת החיבור היחידה לעורך: כל שלוש היכולות (סקריפטים,
 * מקליט, קטעי טקסט) עובדות מולו ולא מול SuperDoc ישירות. כך אפשר לבדוק את
 * הערכה עם כפיל בזיכרון, וכך מארח אחר (גרסת מנוע אחרת, עורך אחר) מתחבר
 * במימוש אחד של הממשק הזה.
 */

/** תוצאת פעולה. אותה צורה כמו `CommandOutcome` של otzaria-word-editor. */
export type MacroOutcome = { ok: true } | { ok: false; message: string; reason?: string };

/** תצלום הבחירה במסמך ברגע הקריאה. */
export interface SelectionSnapshot {
  /** הטקסט המסומן. `''` כשאין בחירה או כשלא התבקש. */
  text: string;
  /** האם יש טווח מסומן ולא רק סמן. */
  hasRange: boolean;
  /** מזהה הפסקה שהבחירה מתחילה בה, או `null`. */
  blockId: string | null;
  /** היעד שפעולות כתיבה (`insert`) צורכות. אטום — נמסר חזרה למנוע כמו שהוא. */
  selectionTarget: unknown | null;
  /** האם הבחירה ריקה (סמן בלבד). */
  empty: boolean;
}

/** אירוע הקלדה שהמארח מדווח למקליט ולהשלמה האוטומטית. */
export type TextInputEvent =
  | { kind: 'insert-text'; text: string }
  | { kind: 'insert-paragraph' }
  | { kind: 'delete-backward' }
  | { kind: 'delete-forward' };

/**
 * מה שהערכה צריכה מהעורך. מימוש ל-SuperDoc v2 נמצא ב-`createSuperdocHost`;
 * לבדיקות יש כפיל בזיכרון.
 */
export interface MacroHost {
  commands: {
    /** האם המנוע מכיר את הפקודה. */
    has(id: string): boolean;
    /** מריצה פקודה מהקטלוג של המנוע ומחזירה תוצאה מנורמלת. */
    execute(id: string, payload?: unknown): Promise<MacroOutcome>;
    /** מזהי הפקודות המוכרות, אם המארח יודע למנות אותם. */
    ids(): readonly string[];
  };
  /** מכניסה טקסט במיקום הסמן (או בסוף המסמך כשאין סמן). */
  insertText(text: string): Promise<MacroOutcome>;
  /** מוחקת תווים לאחור מהסמן. */
  deleteBackward(count: number): Promise<MacroOutcome>;
  /** תצלום הבחירה הנוכחית. לעולם לא זורקת. */
  getSelection(options?: { includeText?: boolean }): Promise<SelectionSnapshot>;
  /** מחליפה את כל המופעים של `query` ב-`replacement`. מחזירה כמה הוחלפו. */
  replaceAll(
    query: string,
    replacement: string,
  ): Promise<{ ok: boolean; replaced: number; message?: string }>;
  /** הטקסט המלא של גוף המסמך. `''` כשאינו זמין. */
  getDocumentText(): Promise<string>;
  /** מאזינה לכל פקודה שהמנוע מריץ (מכל מקור). מחזירה פונקציית ביטול. */
  onCommand(listener: (id: string, payload: unknown) => void): () => void;
  /** מאזינה להקלדה במסמך. מחזירה פונקציית ביטול. */
  onTextInput(listener: (event: TextInputEvent) => void): () => void;
}

/** צעד אחד במאקרו מוקלט. JSON-serializable במלואו. */
export type MacroStep =
  | { type: 'command'; id: string; payload?: unknown }
  | { type: 'insert-text'; text: string }
  | { type: 'insert-paragraph' }
  | { type: 'delete-backward'; count: number }
  | { type: 'delete-forward'; count: number };

/** מאקרו מוקלט, כפי שהוא נשמר ומיובא/מיוצא. */
export interface RecordedMacro {
  version: 1;
  id: string;
  name: string;
  /** ISO-8601. */
  createdAt?: string;
  shortcut?: string;
  steps: MacroStep[];
}

/** מאקרו כתוב — סקריפט JavaScript שרץ מול ה-API של הערכה. */
export interface SavedScript {
  id: string;
  name: string;
  source: string;
  shortcut?: string;
}

/** קטע טקסט (Snippet / AutoText). */
export interface Snippet {
  id: string;
  name: string;
  /** תוכן הקטע. תומך במשתני `{{...}}` — ראו `renderSnippet`. */
  text: string;
  /** מילת הפעלה להשלמה אוטומטית: הקלדת המילה ואחריה רווח מחליפה אותה בתוכן. */
  trigger?: string;
  /** קיצור מקלדת, למשל `Ctrl+Alt+1`. */
  shortcut?: string;
}
