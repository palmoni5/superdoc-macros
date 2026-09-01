# superdoc-macros

A macro toolkit for **SuperDoc v2**-based editors. Originally built for [otzaria-word-editor](https://github.com/Y-PLONI/otzaria-word-editor), but fully generic: it has no dependency on that project — nor on the superdoc package itself (the engine is consumed structurally, through its public surfaces), and the core works against any editor that implements a small `MacroHost` interface.

The capabilities, in the spirit of Word macros:

| Capability | What it gives you |
| --- | --- |
| **Scripted macros** | User-written JavaScript macros that run in a real sandbox (an isolated iframe) against a small, safe document API |
| **Macro recorder** | "Record → work normally → stop → replay" — records commands and typing, like Word's recorder |
| **Snippets (AutoText)** | Templates with variables (`{{date}}`, `{{selection}}`…), keyboard shortcuts, and auto-expansion while typing (type a trigger word + space) |
| **VBA import (read-only)** | Reads the macros already inside a `.docm` and shows the user their real source, so they can port it. Nothing is executed |
| **Built-in tools** | Host-implemented document actions registered on the kit — listed, run and shortcut-bound alongside everything else |

Plus: persistence (localStorage or custom storage), JSON import/export, keyboard shortcut binding, and localizable runtime messages (English by default, Hebrew locale included).

> **A note on VBA:** the toolkit does not *execute* VBA — there is no VBA engine in the browser, and running document-supplied code is not something it will grow into. What it does instead is two things: it lets a user **see** the macros a `.docm` already contains (section 5), and it provides a parallel, JavaScript-based macro system to rewrite them in.

## Installation

```bash
npm install superdoc-macros
```

## Quick start (with SuperDoc)

```ts
import { MacroKit, createSuperdocHost } from 'superdoc-macros';

// superdoc — a ready SuperDoc instance (after onReady); container — the element the document renders in.
const host = createSuperdocHost({ superdoc, container });
const kit = new MacroKit({ host });

// Keyboard shortcuts for everything saved, and auto-text:
const unbindKeys = kit.attachShortcuts(container);
const disableAutoText = kit.enableAutoText();

// On document swap / teardown:
unbindKeys();
disableAutoText();
host.dispose();
```

## 1. Scripted macros

A script receives an `api` object; every method is async:

```ts
kit.saveScript({
  name: 'Heading helper',
  shortcut: 'Ctrl+Alt+D',
  source: `
    await api.bold();
    const selected = await api.getSelectionText();
    if (selected) await api.insertText(selected);
    await api.bold();
    await api.insertParagraph();
  `,
});

const result = await kit.runScript(kit.listScripts()[0].id);
if (!result.ok) console.warn(result.message);
```

### The script API

| Method | Description |
| --- | --- |
| `api.command(id, payload?)` | Any command from the SuperDoc catalog (`'text-align'`, `'font-size'`…). Returns `{ok}`, never throws |
| `api.hasCommand(id)` / `api.commandIds()` | Capability discovery |
| `api.insertText(text)` / `api.insertParagraph()` | Insert at the caret |
| `api.deleteBackward(count?)` | Delete backwards |
| `api.getSelection()` / `api.getSelectionText()` | The current selection |
| `api.getDocumentText()` | The full document text |
| `api.replaceAll(find, replace)` | Replace everywhere; returns the count |
| `api.bold()` / `italic()` / `underline()` / `bulletList()` / `directionRtl()` … | Sugar for common commands — these throw on failure, so the script stops |
| `api.log(...)` | Run log (delivered to the kit's `onLog`) |

### Security

The default is a **real sandbox**: scripts run in an iframe with `sandbox="allow-scripts"` only — an opaque origin, no access to the application's DOM, localStorage or cookies — plus a `default-src 'none'` CSP inside the iframe, so the script cannot fetch or open sockets to the public internet either. The script's only way to touch the document is the API above, with a time cap (default 30 s — enforced even against infinite loops, by removing the iframe) and a call cap (10,000). When a run ends (result, error or timeout), its bridge is revoked: any late call is rejected and can no longer touch the document.

Honest limits: the browser offers no per-iframe memory cap, and a host call that already reached the engine cannot be aborted mid-flight (the engine exposes no cancellation) — what is guaranteed is that nothing new starts.

If you must waive isolation (e.g. a CSP that blocks `srcdoc`), switch to the direct runner: `new MacroKit({ host, runner: 'eval' })` — see the warnings in the code.

**A real off switch:** `new MacroKit({ host, scriptsEnabled: false })` gates script *execution*, not just UI — `runScript`/`runSource` refuse and saved script shortcuts are not bound, so a pre-existing or imported script cannot run through any path. Recordings and snippets are unaffected.

## 2. Macro recorder

```ts
if (!kit.startRecording()) {
  throw new Error('A macro is running or an unsaved recording is pending');
}
// the user works normally: typing, formatting, lists...
const recording = kit.stopRecording('Standard intro', 'Ctrl+Alt+1');

// later, from anywhere in the document:
await kit.replayRecording(recording.id);
```

The recorder captures **commands and typing**, not caret positions — exactly like Word's recorder: replay applies wherever the caret stands. Consecutive keystrokes coalesce into one step, `undo`/`redo` are not recorded (configurable via `RecorderOptions`), and recordings persist as clean JSON that can be exported and shared. `updateRecording({id, name?, shortcut?})` renames a recording or edits its shortcut.

Finalization is loss-aware. A command payload that cannot be stored faithfully is reported instead of silently omitted; `stopRecording()` keeps the stopped capture pending until it is saved or explicitly cancelled. A mixed capture requires `{ allowIncomplete: true }` after the host has obtained user consent, while a capture containing no replayable step is rejected as `recording-uncapturable`. Storage, capacity, and validation failures are retryable: fix the problem and call `stopRecording()` again. Starting a new recording while one is pending is rejected, preventing accidental loss.

## 3. Snippets and auto-text

```ts
kit.saveSnippet({ name: 'BSD', text: 'בס"ד', trigger: 'בסד' });
kit.saveSnippet({
  name: 'Signature',
  text: 'Best regards, {{date}}',
  shortcut: 'Ctrl+Alt+S',
});
kit.saveSnippet({ name: 'Citation', text: '(see {{selection}})' });

kit.enableAutoText();          // from now on: typing the trigger + space expands it
await kit.expandSnippet(id);   // or expand explicitly / via the shortcut
```

Built-in variables: `{{date}}`, `{{time}}`, `{{datetime}}` (formatted with the browser locale, or an explicit `locale` option), `{{selection}}`. Any other name resolves from the `variables` passed to `expandSnippet`; a variable with no value stays visible in the text.

## 4. Built-in tools

A host often ships native document-processing actions of its own — implemented against its full engine access, beyond what the sandboxed script API exposes. Registering them on the kit puts them next to recordings and scripts: one management UI, one run-at-a-time guard, and one shortcut system with persistence and collision rules.

```ts
kit.registerTool({
  id: 'typography.first-word',
  name: 'Format first word',
  description: 'Enlarges the first word of every selected paragraph',
  run: () => applyFirstWordDesign(editor),   // host code, returns { ok } / { ok: false, message }
});

kit.listTools();                              // [{ id, name, description, shortcut? }]
await kit.runTool('typography.first-word');   // refused while recording or while another macro runs
kit.setToolShortcut('typography.first-word', 'Ctrl+Alt+1');  // persisted; validated like every binding
```

Tools are runtime registrations — they are never persisted or exported. Only their shortcuts are, keyed by the tool id, so a shortcut survives restarts and waits for the day its tool is registered again; an unregistered tool's shortcut is never bound.

## 5. Reading the VBA in an existing `.docm`

A user who has relied on a macro-enabled document for years should not be told their macros are simply gone. This reads the macro project out of the package and hands back each module's real source text:

```ts
import { extractVbaFromDocx } from 'superdoc-macros';

const result = await extractVbaFromDocx(fileBytes);   // Uint8Array of the .docm

if (!result.ok) {
  // 'no-macros' is the ordinary answer for a document without any.
  console.log(result.reason, result.message);
} else {
  for (const module of result.project.modules) {
    console.log(module.name, module.kind, module.source);
  }
  for (const warning of result.project.warnings) {
    console.log(warning.code, warning.message);
  }
}
```

Hebrew and other non-Latin sources come back correct: VBA stores text in the project's code page (windows-1255 for Hebrew), and that is honoured rather than assumed to be UTF-8.

When the answer decides something other than what to display — which extension to save under, say — ask the cheap question instead. `findVbaPart` reads only the relationship and content-type parts, decompresses nothing from the project itself, and never throws:

```ts
import { findVbaPart } from 'superdoc-macros';

const part = await findVbaPart(fileBytes);   // 'word/vbaProject.bin' | null
```

Use this rather than "did extraction succeed", because the two answer different questions: a project too damaged to read is still a macro project, and a document carrying one must keep its `.docm` extension either way. For the same reason a failed extraction still reports `partName` whenever a macro part was located.

Verified against genuine Office output, not only synthetic files — Word-authored `.docm` documents (including a Cyrillic, code-page-1251 project, and projects carrying `Tools ▸ References` entries) come back with their real module names, kinds and recorded-macro source intact. The test suite pins this with a real macro project as a fixture, alongside synthetic ones covering both container layouts, a Hebrew code page, and the record whose declared length the format itself gets wrong.

### This does not run anything, and it is not wired to anything that does

The security position is deliberate and worth stating plainly, because VBA in a document is code that arrived from outside:

- **Nothing executes.** There is no interpreter, no transpiler, no `eval`. The functions decode bytes into strings.
- **The extracted `source` is data, not code.** Never pass it to a script runner or to `new Function`: VBA is not JavaScript, so anything that did run would be attacker-chosen text reaching a JavaScript parser.
- **Extraction is deliberately *not* a `MacroKit` method.** It creates no saved macro, binds no shortcut, and writes nothing to storage. Turning an extracted module into something runnable stays an explicit human decision, and the API shape says so.
- **Auto-run entry points are reported, never honoured.** Word runs `AutoOpen`, `Document_Open` and friends on its own, which is exactly why they are a long-standing malware vector. They are listed in `project.autoRunProcedures` and raise an `auto-run-macros` warning so a host can tell the user what the original document did. `scanForAutoRunProcedures(source)` is exported for the same check on VBA from anywhere else.

### Failure is a result, not an exception

`extractVbaFromDocx` and `extractVbaProject` never throw — not on a truncated file, not on a hostile one. Every outcome is a result carrying a stable `reason` (`no-macros`, `not-a-package`, `not-a-vba-project`, `too-large`, `unsupported`, `unreadable`).

Partial success is reported honestly rather than silently: a module that cannot be decoded appears in `warnings` with its name instead of vanishing from the list. Each warning carries a stable `code` to switch on (the `message` is English):

| `code` | Meaning |
| --- | --- |
| `auto-run-macros` | The document defines macros Word would run on open. Read for review; not executed |
| `module-unreadable` | A named module could not be decoded and was skipped |
| `module-truncated` | A module's source was longer than the cap and was cut |
| `declared-modules-missing` | The project declares modules the directory walk did not produce — the list you have is incomplete, and these are the names |
| `incomplete-directory` | The macro directory ended unexpectedly; modules may be missing |
| `no-modules` | The project has no readable modules |
| `unknown-code-page` | The declared code page is unavailable here; text fell back to windows-1252 and non-Latin characters may be wrong |
| `module-limit` / `total-size-limit` | A `VBA_LIMITS` cap stopped the read |

The gap-reporting codes exist because a plausible-looking short list is worse than a short list with an explanation. `declared-modules-missing` is the strongest of them: it cross-checks the modules found against the project's own manifest, so a malformed record that desynchronizes the directory walk surfaces as a named gap rather than a module that quietly is not there.

### Bounded against a file built to hurt you

Every reader is bounded (`VBA_LIMITS`, `CFB_LIMITS`, `ZIP_LIMITS`) and every chain walk is loop-guarded, so a container whose allocation table points in a circle terminates, and a part declaring an absurd size is refused.

Counting structural items is not enough on its own, though, and that is the part worth knowing about. A caller's real exposure is in quantities *derived* from the file, which a small input can inflate enormously — so those are metered too:

- **Path length and nesting depth**, not just entry count. Storages nested one inside the next make each path longer than the last, so retained path strings grow with the square of the entry count.
- **Bytes decompression actually produces**, not the size a header claims. The ZIP reader enforces its cap while inflating, so a part that declares a kilobyte and expands to a gigabyte is abandoned rather than buffered and then rejected.
- **Warning count**, keyed on modules *considered* rather than modules successfully read — otherwise a project whose every stream fails emits one warning per record.
- **Regex exposure.** XML is scanned with `indexOf`, not with a `<Tag[^>]*>` pattern, which backtracks quadratically on input containing no `>` at all. On a 260 KB input the difference measured 3 ms against 1.7 s, and it grows with the square.

These are regression-tested, not just asserted: a deterministic corruption sweep over the container header and allocation tables, a deeply nested directory, XML crafted to force backtracking, a declared-size lie over expanding data, and a project declaring more modules than it has streams.

No new dependencies: the OLE container reader, the ZIP reader and the [MS-OVBA] decompressor are part of the package. Inflation is delegated to the platform's own `DecompressionStream` — [Baseline across browsers since 2023](https://web.dev/blog/compressionstreams), and present in Node 18+ — so the decompression itself runs in audited native code rather than a hand-rolled inflater. An environment without it gets `reason: 'unsupported'`, not a crash.

### Macros survive a save

Independently of the above: a macro-enabled document that SuperDoc opens and exports **keeps its macro project intact**. Verified end-to-end against the SuperDoc v2 engine — open a `.docm`, edit the body, export, and `word/vbaProject.bin` comes back byte-identical, with the `macroEnabled` content type and the `vbaProject` relationship preserved, in all three export modes.

Two things are the host's job:
- **Save with the right extension.** A file carrying a macro project must stay `.docm`/`.dotm`; handing Word a `.docx` with a `vbaProject` part inside makes it complain.
- **Don't rebuild the package by hand.** If you ever do, copy `word/vbaProject.bin`, `word/vbaData.xml`, the `vbaProject` relationship and the `[Content_Types].xml` override across from the original.

## Localization

Runtime messages (failures shown to end users) default to English. A host with a localized UI swaps them once at startup:

```ts
import { setMacroMessages, HEBREW_MESSAGES } from 'superdoc-macros';

setMacroMessages(HEBREW_MESSAGES);          // full Hebrew locale (included)
setMacroMessages({ scriptNotFound: '…' });  // or a partial override
```

## Persistence, import and export

```ts
import { createLocalStorage } from 'superdoc-macros';

const kit = new MacroKit({ host, storage: createLocalStorage('my-key') });

const json = kit.exportState();       // backup / sharing
kit.importState(json, { merge: true });
```

`MacroStorage` is a two-method interface — implement it to persist to a file (e.g. a plugin workspace).

Imports are strictly validated **atomically on the final result**: every item and every recorded step is type-checked and size-bounded (see `IMPORT_LIMITS`), every shortcut in the merged state must pass the same binding rules the save paths enforce (modifier required, not host-reserved, no duplicates), and any failure rejects the whole file with the current state untouched — no partial imports.

The same limits hold as a persistence invariant, transactionally: every mutation runs on a clone that must serialize under the loader's exact rules (shape, field caps, whole-file size) *and* be accepted by the storage before it becomes the state — a quota failure or an oversized save leaves memory and disk agreeing on the previous state, and can never wipe the store on the next startup. An oversized recorded paste is split into loadable steps; a recording that cannot be saved whole is refused with a message rather than saved partially.

## Shortcut safety

Saved bindings go through `kit.validateShortcut(shortcut, excludeId?)` — enforced on every save and on the merged result of every import: a binding must parse, must carry a real modifier (Ctrl/Alt/Meta — a bare letter would fire on ordinary typing), must use a physically-mappable key (letters, digits, F-keys — matching is by `event.code`, so bindings survive non-Latin keyboard layouts), must not collide with another saved item, and must not collide with shortcuts the host declared as reserved. Auto-repeat and keys mid-IME-composition never fire bindings:

```ts
const kit = new MacroKit({ host, reservedShortcuts: ['Ctrl+S', 'Ctrl+P', /* … the editor's registry … */] });
```

## Connecting a different host

The whole toolkit works against a single `MacroHost` interface (commands, text insertion, selection, replace, typing events). `createSuperdocHost` is the implementation for SuperDoc v2 in `ui: false` mode; another editor plugs in with its own implementation — see `src/types.ts` and the double in `tests/fake-host.ts`.

## Known limitations

- No VBA execution. `.docm` files open normally and their macros can be *read* (section 4), but nothing runs them — by design, not for want of trying.
- VBA import reads code modules. It does not reconstruct UserForm layouts (only a form's code-behind), and it does not read the `vbaData.xml` keyboard-shortcut map — a `.docm`'s macro key bindings are not imported.
- VBA import does not open ZIP64 or password-protected packages; both are refused with `reason: 'unsupported'` rather than guessed at.
- The recorder does not capture caret movement or mouse selection (as in Word — replay acts from the current caret).
- `deleteBackward` and full-document text use the engine's internal view (ProseMirror) — available in the browser, not headless.
- The `eval` runner's time cap cannot stop an infinite synchronous loop (the iframe runner's can).

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc → dist/
```

**Releasing:** bump `version` in package.json and push to main — the workflow (.github/workflows/release.yml) publishes to npm and creates a GitHub Release automatically.

## License

MIT
