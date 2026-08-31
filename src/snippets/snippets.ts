/**
 * Text snippets: templates inserted at the caret, with `{{...}}` variables.
 *
 * Built-in variables: `{{date}}`, `{{time}}`, `{{datetime}}` (system clock,
 * formatted with the configured locale) and `{{selection}}` (the selected
 * text at expansion time). Any other name resolves from the `variables`
 * passed to the call; a variable with no value stays visible in the text —
 * so a typo shows up in the document instead of vanishing silently.
 */
import type { MacroHost, MacroOutcome, Snippet } from '../types.js';

export interface RenderContext {
  /** Values for custom variables. */
  variables?: Readonly<Record<string, string>>;
  /** The text substituted for `{{selection}}`. */
  selectionText?: string;
  /** The time for `{{date}}`/`{{time}}`. Default: now. Exists for tests. */
  now?: Date;
  /** BCP-47 locale for date/time formatting. Default: the browser's. */
  locale?: string;
}

const VARIABLE_PATTERN = /\{\{\s*([\p{L}\p{N}_-]+)\s*\}\}/gu;

export function renderSnippet(text: string, context: RenderContext = {}): string {
  const now = context.now ?? new Date();
  const locale = context.locale;

  return text.replace(VARIABLE_PATTERN, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    switch (name) {
      case 'date':
        return now.toLocaleDateString(locale);
      case 'time':
        return now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
      case 'datetime':
        return `${now.toLocaleDateString(locale)} ${now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
      case 'selection':
        return context.selectionText ?? '';
      default: {
        const value = context.variables?.[rawName] ?? context.variables?.[name];
        return value ?? whole;
      }
    }
  });
}

/** Whether the snippet uses `{{selection}}` — in which case expansion must read the selection. */
export function usesSelection(text: string): boolean {
  return /\{\{\s*selection\s*\}\}/iu.test(text);
}

export interface ExpandOptions {
  variables?: Readonly<Record<string, string>>;
  now?: Date;
  locale?: string;
}

/**
 * Renders a snippet against the live document (reads the selection only
 * when the snippet needs it). Split from the insertion so a caller that
 * must know what text actually landed — e.g. a recorder — can.
 */
export async function renderSnippetForHost(
  host: MacroHost,
  snippet: Pick<Snippet, 'text'>,
  options: ExpandOptions = {},
): Promise<string> {
  const selectionText = usesSelection(snippet.text)
    ? (await host.getSelection({ includeText: true })).text
    : undefined;

  return renderSnippet(snippet.text, {
    variables: options.variables,
    selectionText,
    now: options.now,
    locale: options.locale,
  });
}

/** Expands a snippet at the caret. */
export async function expandSnippet(
  host: MacroHost,
  snippet: Pick<Snippet, 'text'>,
  options: ExpandOptions = {},
): Promise<MacroOutcome> {
  return host.insertText(await renderSnippetForHost(host, snippet, options));
}
