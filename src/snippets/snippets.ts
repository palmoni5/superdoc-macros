/**
 * קטעי טקסט (Snippets): תבניות שמוכנסות במיקום הסמן, עם משתני `{{...}}`.
 *
 * משתנים מובנים: `{{date}}`, `{{time}}`, `{{datetime}}` (בעברית, לפי שעון
 * המערכת), `{{selection}}` (הטקסט המסומן ברגע ההרחבה). כל שם אחר נפתר מתוך
 * `variables` שנמסרו בקריאה; משתנה שאין לו ערך נשאר כמו שהוא בטקסט — כדי
 * שטעות כתיב תיראה במסמך ולא תיעלם בשקט.
 */
import type { MacroHost, MacroOutcome, Snippet } from '../types.js';

export interface RenderContext {
  /** ערכים למשתנים מותאמים. */
  variables?: Readonly<Record<string, string>>;
  /** הטקסט שיוצב ב-`{{selection}}`. */
  selectionText?: string;
  /** הזמן ל-`{{date}}`/`{{time}}`. ברירת מחדל: עכשיו. קיים בשביל בדיקות. */
  now?: Date;
}

const VARIABLE_PATTERN = /\{\{\s*([\p{L}\p{N}_-]+)\s*\}\}/gu;

export function renderSnippet(text: string, context: RenderContext = {}): string {
  const now = context.now ?? new Date();

  return text.replace(VARIABLE_PATTERN, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    switch (name) {
      case 'date':
        return now.toLocaleDateString('he-IL');
      case 'time':
        return now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      case 'datetime':
        return `${now.toLocaleDateString('he-IL')} ${now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
      case 'selection':
        return context.selectionText ?? '';
      default: {
        const value = context.variables?.[rawName] ?? context.variables?.[name];
        return value ?? whole;
      }
    }
  });
}

/** האם הקטע משתמש ב-`{{selection}}` — ואז ההרחבה צריכה לקרוא את הבחירה. */
export function usesSelection(text: string): boolean {
  return /\{\{\s*selection\s*\}\}/iu.test(text);
}

export interface ExpandOptions {
  variables?: Readonly<Record<string, string>>;
  now?: Date;
}

/** מרחיבה קטע במיקום הסמן. */
export async function expandSnippet(
  host: MacroHost,
  snippet: Pick<Snippet, 'text'>,
  options: ExpandOptions = {},
): Promise<MacroOutcome> {
  // הבחירה נקראת רק כשנחוצה: חילוץ טקסט הבחירה עולה בביצועים במנוע.
  const selectionText = usesSelection(snippet.text)
    ? (await host.getSelection({ includeText: true })).text
    : undefined;

  const rendered = renderSnippet(snippet.text, {
    variables: options.variables,
    selectionText,
    now: options.now,
  });

  return host.insertText(rendered);
}
