/**
 * Reading the VBA macros out of a Word document — for review, never for
 * execution.
 *
 * ## What this is for
 *
 * A user opens a `.docm` they have relied on for years and asks where their
 * macros went. The honest answer used to be "we cannot see them at all".
 * This module changes that: it reads the macro project out of the package and
 * hands back each module's real source text, so a host can show the user what
 * the document actually contains and let them port it to a scripted macro.
 *
 * ## What this is emphatically not
 *
 * There is no VBA engine here and no path to one. Nothing in this module
 * executes, compiles, or converts anything — it decodes bytes into strings.
 * That is a deliberate security position, not a missing feature:
 *
 * - **Nothing runs, ever.** VBA in a document arrives from outside; auto-run
 *   entry points (`AutoOpen`, `Document_Open`, …) are a decades-old malware
 *   vector precisely because Word honours them. This module reports those
 *   procedures in `autoRunProcedures` so a host can warn about them, and
 *   gives them no special treatment beyond that.
 * - **Extracted text is data, not code.** A returned `source` string must
 *   never be fed to `eval`, to `new Function`, or to the toolkit's script
 *   runners: VBA is not JavaScript, so anything that did run would be
 *   attacker-chosen text reaching a JavaScript parser. Show it, save it,
 *   export it, let a human rewrite it.
 * - **Extraction changes nothing.** Reading a document's macros neither
 *   creates a saved macro nor binds a shortcut. Turning any of this into
 *   something runnable stays an explicit, human decision.
 *
 * ## Failure posture
 *
 * The public functions never throw — not on a truncated file, not on a
 * hostile one. Every outcome is a discriminated result carrying a stable
 * `reason` code, and partial success is reported honestly: a module that
 * cannot be decoded is listed in `warnings` rather than silently dropped, in
 * the same spirit as the recorder's loss-aware finalization.
 *
 * ## Note on saving
 *
 * Extraction is read-only and does not affect saving. A macro-enabled
 * document that SuperDoc opens and exports keeps its `vbaProject.bin` intact
 * — see the README for the details and for the caveat about the file
 * extension.
 */
import { readCfb, type CfbContainer } from './cfb.js';
import { isVbaParseError, VbaParseError } from './errors.js';
import { decompressOvba } from './ms-ovba.js';
import { openZip, type ZipArchive } from './zip.js';

export const VBA_LIMITS = {
  maxModules: 500,
  /** One module's source text, in characters. Longer sources are truncated. */
  maxSourceLength: 500_000,
  /** All modules together, in characters. */
  maxTotalSourceLength: 5_000_000,
} as const;

/**
 * Word runs these without being asked, which is exactly why they are called
 * out. Matching is case-insensitive; VBA identifiers are case-insensitive.
 */
const AUTO_RUN_PROCEDURES: readonly string[] = [
  'AutoExec',
  'AutoOpen',
  'AutoNew',
  'AutoClose',
  'AutoExit',
  'Document_Open',
  'Document_New',
  'Document_Close',
  'Auto_Open',
  'Auto_Close',
  'Workbook_Open',
];

export type VbaModuleKind =
  /** A plain code module — where recorded Word macros land. */
  | 'standard'
  /** A class module. */
  | 'class'
  /** A document-bound module such as `ThisDocument`. */
  | 'document'
  /** A UserForm's code-behind. */
  | 'form'
  | 'unknown';

export interface VbaModule {
  /** The module's name as the VBA editor shows it, e.g. `Module1`. */
  readonly name: string;
  readonly kind: VbaModuleKind;
  /**
   * The module's source text, decoded but otherwise untouched: original line
   * endings, leading `Attribute` lines included.
   *
   * Data, not code. See this module's header — never hand it to a runner.
   */
  readonly source: string;
  /** Whether `source` was cut short at `VBA_LIMITS.maxSourceLength`. */
  readonly truncated: boolean;
}

export interface VbaWarning {
  /** Stable identifier — the key a host localizes on. */
  readonly code:
    | 'no-modules'
    | 'incomplete-directory'
    | 'declared-modules-missing'
    | 'module-unreadable'
    | 'module-truncated'
    | 'module-limit'
    | 'total-size-limit'
    | 'unknown-code-page'
    | 'auto-run-macros';
  /** English text. Hosts with a localized UI should switch on `code`. */
  readonly message: string;
}

export interface VbaProcedureRef {
  readonly module: string;
  readonly procedure: string;
}

export interface VbaProject {
  readonly modules: readonly VbaModule[];
  /** The code page the sources were decoded with. */
  readonly codePage: number;
  /**
   * Auto-run entry points found in the sources. Informational: a host should
   * warn the user that the original document ran these on open. Nothing in
   * the toolkit acts on them.
   */
  readonly autoRunProcedures: readonly VbaProcedureRef[];
  /** Package path the project was read from, when it came from a package. */
  readonly partName?: string;
  readonly warnings: readonly VbaWarning[];
}

export type VbaFailureReason =
  /** Not a readable OOXML/ZIP package. */
  | 'not-a-package'
  /** A valid package that carries no macro project. */
  | 'no-macros'
  /** A macro part that is not a readable VBA project. */
  | 'not-a-vba-project'
  /** Structurally valid but past a safety cap. */
  | 'too-large'
  /** A format feature the readers decline to guess at (ZIP64, encryption). */
  | 'unsupported'
  /** Damaged or truncated beyond recovery. */
  | 'unreadable';

export type VbaExtraction =
  | { readonly ok: true; readonly project: VbaProject }
  | {
      readonly ok: false;
      readonly reason: VbaFailureReason;
      readonly message: string;
      /**
       * The macro part's path, when one was found but could not be read.
       *
       * This is the difference between "this document has no macros" and "this
       * document has macros we could not decode", and a host needs it: a
       * package carrying a macro part must still be saved as `.docm`, whether
       * or not anything could be shown to the user.
       */
      readonly partName?: string;
    };

/* ------------------------------------------------------------------ *
 * dir stream
 * ------------------------------------------------------------------ */

/** [MS-OVBA] 2.3.4.2 record ids this reader cares about. */
const RECORD = {
  projectCodePage: 0x0003,
  moduleName: 0x0019,
  /** UTF-16 counterpart of MODULENAME — code-page independent. */
  moduleNameUnicode: 0x0047,
  moduleStreamName: 0x001a,
  /** UTF-16 counterpart of MODULESTREAMNAME, stored as a Reserved record. */
  moduleStreamNameUnicode: 0x0032,
  moduleType_procedural: 0x0021,
  moduleType_document: 0x0022,
  moduleOffset: 0x0031,
  /** Declares a 4-byte size but carries 6 — see `recordSize`. */
  projectVersion: 0x0009,
  terminator: 0x0010,
} as const;

interface DirModule {
  name: string;
  streamName: string;
  /**
   * The UTF-16 names, when the project carries them. Preferred over the
   * code-page ones: the CFB directory stores entry names as UTF-16 too, so
   * matching on these needs no code page to be right. A Hebrew module name on
   * a host whose `TextDecoder` lacks windows-1255 decodes to the wrong string
   * from the MBCS record and then matches nothing.
   */
  nameUnicode: string | null;
  streamNameUnicode: string | null;
  textOffset: number;
  /** Whether the project stated an offset at all — 0 is also "not stated". */
  hasTextOffset: boolean;
  kind: VbaModuleKind;
}

/** A name field still in its original code page, pending decoding. */
interface PendingName {
  module: DirModule;
  field: 'name' | 'streamName';
  bytes: Uint8Array;
}

interface DirParse {
  modules: DirModule[];
  codePage: number | null;
  pendingNames: PendingName[];
  /**
   * Whether the walk reached the directory's terminator record. When it did
   * not, the record stream ran out or a record misstated its length — so the
   * module list may be short, and saying so beats a silently partial list.
   */
  complete: boolean;
  /**
   * Whether the walk stopped because the module cap was reached. Kept apart
   * from `complete` so the user is told the right thing: hitting our own
   * limit is not the same event as a damaged directory.
   */
  moduleLimitReached: boolean;
}

/**
 * The declared size of a `dir` record, corrected for the one record whose
 * declared size the format gets wrong. PROJECTVERSION states 4 bytes but is
 * followed by 6 (a 4-byte major and a 2-byte minor); trusting the declared
 * size desynchronizes the whole walk from that point on, and every module
 * after it disappears.
 */
function recordSize(id: number, declared: number): number {
  return id === RECORD.projectVersion ? 6 : declared;
}

function parseDirStream(dir: Uint8Array): DirParse {
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const modules: DirModule[] = [];
  let codePage: number | null = null;
  let current: DirModule | null = null;
  let complete = false;
  let moduleLimitReached = false;
  let at = 0;

  // Names are decoded once the code page is known, which the format
  // guarantees comes first — but the raw bytes are kept so a project that
  // breaks that ordering still decodes correctly.
  const pendingNames: PendingName[] = [];

  while (at + 6 <= dir.length) {
    const id = view.getUint16(at, true);
    const declared = view.getUint32(at + 2, true);
    const size = recordSize(id, declared);
    const dataStart = at + 6;
    if (size < 0 || dataStart + size > dir.length) break;
    const data = dir.subarray(dataStart, dataStart + size);

    switch (id) {
      case RECORD.projectCodePage:
        // Unsigned: code page 65001 (UTF-8) would read as a negative number
        // if this were signed.
        if (size >= 2) codePage = view.getUint16(dataStart, true);
        break;
      case RECORD.moduleName:
        // Capped here rather than at the consumer, because each entry costs
        // an object and a copied name buffer. A `dir` stream that is nothing
        // but MODULENAME records is a few bytes each and compresses to
        // nothing, so an uncapped walk turns a tiny file into millions of
        // allocations.
        if (modules.length >= VBA_LIMITS.maxModules) {
          moduleLimitReached = true;
          at = dir.length;
          continue;
        }
        current = {
          name: '',
          streamName: '',
          nameUnicode: null,
          streamNameUnicode: null,
          textOffset: 0,
          hasTextOffset: false,
          kind: 'unknown',
        };
        modules.push(current);
        pendingNames.push({ module: current, field: 'name', bytes: data.slice() });
        break;
      case RECORD.moduleNameUnicode:
        if (current) current.nameUnicode = decodeUtf16(data);
        break;
      case RECORD.moduleStreamName:
        if (current) pendingNames.push({ module: current, field: 'streamName', bytes: data.slice() });
        break;
      case RECORD.moduleStreamNameUnicode:
        if (current) current.streamNameUnicode = decodeUtf16(data);
        break;
      case RECORD.moduleOffset:
        if (current && size >= 4) {
          current.textOffset = view.getUint32(dataStart, true);
          current.hasTextOffset = true;
        }
        break;
      case RECORD.moduleType_procedural:
        if (current) current.kind = 'standard';
        break;
      case RECORD.moduleType_document:
        // [MS-OVBA]: this id means "document, class, or designer module" — it
        // does not distinguish them. Claiming `class` here would be a guess;
        // the PROJECT stream is what actually tells them apart, and when it
        // is unreadable `unknown` is the honest answer.
        if (current) current.kind = 'unknown';
        break;
      case RECORD.terminator:
        complete = true;
        at = dir.length;
        continue;
    }

    at = dataStart + size;
  }

  return { modules, codePage, pendingNames, complete, moduleLimitReached };
}

/** UTF-16LE, the encoding the format's `*Unicode` records and CFB names use. */
function decodeUtf16(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  try {
    const text = new TextDecoder('utf-16le').decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * text decoding
 * ------------------------------------------------------------------ */

/**
 * VBA stores names and sources in the project's code page, not UTF-8 — a
 * Hebrew comment written in Word lands as windows-1255 bytes. Decoding it as
 * UTF-8 turns the whole file into replacement characters, so the declared
 * code page has to be honoured.
 */
const CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  10000: 'macintosh',
  10007: 'x-mac-cyrillic',
  20127: 'windows-1252', // US-ASCII, a strict subset
  20866: 'koi8-r',
  21866: 'koi8-u',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28593: 'iso-8859-3',
  28594: 'iso-8859-4',
  28595: 'iso-8859-5',
  28596: 'iso-8859-6',
  28597: 'iso-8859-7',
  28598: 'iso-8859-8',
  28599: 'iso-8859-9',
  28603: 'iso-8859-13',
  28605: 'iso-8859-15',
  65001: 'utf-8',
};

const FALLBACK_CODE_PAGE = 1252;

function makeDecoder(codePage: number): { decode: (bytes: Uint8Array) => string; recognized: boolean } {
  const label = CODE_PAGE_LABELS[codePage];
  if (label) {
    try {
      const decoder = new TextDecoder(label);
      return { decode: (bytes) => decoder.decode(bytes), recognized: true };
    } catch {
      // The environment does not carry this encoding — fall through.
    }
  }
  const fallback = new TextDecoder(CODE_PAGE_LABELS[FALLBACK_CODE_PAGE] ?? 'windows-1252');
  return { decode: (bytes) => fallback.decode(bytes), recognized: false };
}

/* ------------------------------------------------------------------ *
 * PROJECT stream — module kinds
 * ------------------------------------------------------------------ */

/** A module the `PROJECT` stream declares, with its name as written there. */
interface DeclaredModule {
  kind: VbaModuleKind;
  name: string;
}

/**
 * The `PROJECT` stream is plain text and states each module's kind, which the
 * `dir` stream only narrows to "procedural or not". It is the only way to
 * tell a UserForm's code-behind from an ordinary class — and, because it
 * names every module independently, it doubles as a check on the directory
 * walk.
 */
function parseProjectStream(text: string): Map<string, DeclaredModule> {
  const declared = new Map<string, DeclaredModule>();
  const maxDeclared = VBA_LIMITS.maxModules * 2;
  const keyToKind: Readonly<Record<string, VbaModuleKind>> = {
    module: 'standard',
    class: 'class',
    document: 'document',
    baseclass: 'form',
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (declared.size >= maxDeclared) break;
    const match = /^(Module|Class|Document|BaseClass)=(.*)$/i.exec(line.trim());
    if (!match) continue;
    const kind = keyToKind[match[1]!.toLowerCase()];
    // `Document=ThisDocument/&H00000000` — the name stops at the slash.
    const name = (match[2] ?? '').split('/')[0]?.trim();
    // Keyed case-insensitively, as VBA identifiers are, but the name is kept
    // as written so a warning can quote it the way the user would see it.
    if (kind && name) declared.set(name.toLowerCase(), { kind, name });
  }
  return declared;
}

/* ------------------------------------------------------------------ *
 * auto-run detection
 * ------------------------------------------------------------------ */

const PROCEDURE_PATTERN =
  /^[ \t]*(?:(?:Public|Private|Friend)[ \t]+)?(?:Static[ \t]+)?(?:Sub|Function)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gim;

/**
 * The auto-run entry points declared in a VBA source text, in the order they
 * appear, spelled as the source spells them.
 *
 * Exported because the warning matters more than where the text came from: a
 * host showing VBA a user pasted in, or read from a `.bas` file, wants the
 * same "Word would have run this on open" notice this module attaches to an
 * extracted project.
 *
 * Names are matched case-insensitively, since VBA identifiers are.
 */
export function scanForAutoRunProcedures(source: string): string[] {
  const autoRun = new Set(AUTO_RUN_PROCEDURES.map((name) => name.toLowerCase()));
  // A fresh regex per call: a /g pattern carries lastIndex between uses, so a
  // shared instance would skip matches on the second call.
  const pattern = new RegExp(PROCEDURE_PATTERN.source, PROCEDURE_PATTERN.flags);
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const procedure = match[1];
    if (procedure && autoRun.has(procedure.toLowerCase())) found.push(procedure);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * vbaProject.bin
 * ------------------------------------------------------------------ */

/**
 * Reads a VBA project from the bytes of a `vbaProject.bin` part.
 *
 * Never throws. A partially readable project comes back as `ok: true` with
 * the modules that could be read and a warning for each that could not.
 *
 * @param bin The macro part's bytes.
 * @param partName Where the part came from, recorded on the result. Passed by
 * `extractVbaFromDocx`; a caller reading a loose `.bin` has nothing to give.
 */
export function extractVbaProject(bin: Uint8Array, partName?: string): VbaExtraction {
  try {
    return readProject(bin, partName);
  } catch (error) {
    return toFailure(error, 'not-a-vba-project', partName);
  }
}

function readProject(bin: Uint8Array, partName?: string): VbaExtraction {
  const container = readCfb(bin);
  const warnings: VbaWarning[] = [];

  const dirPath = findDirStream(container);
  if (!dirPath) {
    return {
      ok: false,
      reason: 'not-a-vba-project',
      message: 'The macro project has no VBA directory stream.',
      ...(partName === undefined ? {} : { partName }),
    };
  }
  const storagePath = dirPath.slice(0, dirPath.lastIndexOf('/'));

  const dir = decompressOvba(container.readStream(dirPath));
  const parsed = parseDirStream(dir);

  if (parsed.moduleLimitReached) {
    warnings.push({
      code: 'module-limit',
      message: `The project declares more than ${VBA_LIMITS.maxModules} modules; the rest were not read.`,
    });
  } else if (!parsed.complete) {
    warnings.push({
      code: 'incomplete-directory',
      message: 'The macro directory ended unexpectedly; some modules may be missing from this list.',
    });
  }

  const codePage = parsed.codePage ?? FALLBACK_CODE_PAGE;
  const decoder = makeDecoder(codePage);
  if (!decoder.recognized) {
    warnings.push({
      code: 'unknown-code-page',
      message: `Code page ${codePage} is not available; text was decoded as windows-${FALLBACK_CODE_PAGE} and non-Latin characters may be wrong.`,
    });
  }
  for (const pending of parsed.pendingNames) {
    pending.module[pending.field] = decoder.decode(pending.bytes);
  }

  const declaredModules = readDeclaredModules(container, storagePath, decoder.decode);

  const modules: VbaModule[] = [];
  const autoRunProcedures: VbaProcedureRef[] = [];
  let totalSource = 0;
  let considered = 0;

  for (const entry of parsed.modules) {
    const name = entry.nameUnicode ?? entry.name;
    if (!name) continue;

    // Counted per module *considered*, not per module successfully read.
    // Keying the cap on successes lets a project whose every stream fails
    // run the loop over every record it declares and push a warning each
    // time — an unbounded warning list from a tiny file.
    considered += 1;
    if (considered > VBA_LIMITS.maxModules) {
      warnings.push({
        code: 'module-limit',
        message: `The project declares more than ${VBA_LIMITS.maxModules} modules; the rest were not read.`,
      });
      break;
    }
    if (totalSource >= VBA_LIMITS.maxTotalSourceLength) {
      warnings.push({
        code: 'total-size-limit',
        message: 'The project’s total source size exceeds the cap; the remaining modules were not read.',
      });
      break;
    }

    let decoded: string;
    try {
      const stream = readModuleStream(container, storagePath, entry, name);
      decoded = decoder.decode(decompressOvba(stream, { offset: entry.textOffset }));
    } catch {
      // Honest partial result: the module is named in a warning rather than
      // vanishing from the list without explanation. The stored source being
      // absent is a real possibility here, not only damage — some documents
      // ship with it stripped and only the compiled form left behind.
      warnings.push({
        code: 'module-unreadable',
        message: `Module “${name}” could not be decoded and was skipped — its stored source may be absent or damaged.`,
      });
      continue;
    }

    const truncated = decoded.length > VBA_LIMITS.maxSourceLength;
    const source = truncated ? decoded.slice(0, VBA_LIMITS.maxSourceLength) : decoded;
    if (truncated) {
      warnings.push({
        code: 'module-truncated',
        message: `Module “${name}” is longer than ${VBA_LIMITS.maxSourceLength} characters and was truncated.`,
      });
    }

    modules.push({
      name,
      kind: declaredModules.get(name.toLowerCase())?.kind ?? entry.kind,
      source,
      truncated,
    });
    totalSource += source.length;
    for (const procedure of scanForAutoRunProcedures(source)) {
      autoRunProcedures.push({ module: name, procedure });
    }
  }

  // Cross-check against the PROJECT stream, which names every module
  // independently of the directory walk. If the two disagree, a record in the
  // directory misstated its length and desynchronized the walk — and the user
  // is looking at an incomplete list. Saying which modules are missing is the
  // difference between a known gap and a silent one.
  if (declaredModules.size > 0) {
    const read = new Set(modules.map((module) => module.name.toLowerCase()));
    const missing = [...declaredModules.entries()]
      .filter(([key]) => !read.has(key))
      .map(([, declared]) => declared.name);
    if (missing.length > 0) {
      // The list is for a person to read, so it is trimmed rather than
      // allowed to become a multi-megabyte string.
      const shown = missing.slice(0, 20);
      const rest = missing.length - shown.length;
      warnings.push({
        code: 'declared-modules-missing',
        message: `The project declares ${missing.length} module(s) that could not be read: ${shown.join(', ')}${
          rest > 0 ? `, and ${rest} more` : ''
        }.`,
      });
    }
  }

  if (modules.length === 0) {
    warnings.push({ code: 'no-modules', message: 'The macro project contains no readable modules.' });
  }
  if (autoRunProcedures.length > 0) {
    const list = autoRunProcedures.map((ref) => `${ref.module}.${ref.procedure}`).join(', ');
    warnings.push({
      code: 'auto-run-macros',
      message: `This document defines macros Word would run automatically (${list}). They were read for review only and are not executed.`,
    });
  }

  return {
    ok: true,
    project: {
      modules,
      codePage,
      autoRunProcedures,
      warnings,
      ...(partName === undefined ? {} : { partName }),
    },
  };
}

/** How much of the `PROJECT` stream is worth parsing. Real ones are a few hundred bytes. */
const MAX_PROJECT_STREAM_BYTES = 256 * 1024;

/**
 * The modules the `PROJECT` stream declares, with their kinds.
 *
 * `PROJECT` sits beside the VBA storage rather than at a fixed path, so it is
 * looked up relative to where the directory stream was actually found. An
 * unreadable or absent stream is not an error: kinds degrade to what `dir`
 * said, and the cross-check simply has nothing to compare against.
 */
function readDeclaredModules(
  container: CfbContainer,
  storagePath: string,
  decode: (bytes: Uint8Array) => string,
): Map<string, DeclaredModule> {
  const parent = storagePath.slice(0, storagePath.lastIndexOf('/'));
  const candidates = [`${parent}/PROJECT`, '/PROJECT'];

  for (const path of candidates) {
    const entry = container.entries.find(
      (candidate) => candidate.type === 'stream' && candidate.path === path,
    );
    // Checked before reading, so an absurdly sized stream is never
    // materialized just to be thrown away.
    if (!entry || entry.size === 0 || entry.size > MAX_PROJECT_STREAM_BYTES) continue;
    try {
      return parseProjectStream(decode(container.readStream(path)));
    } catch {
      // Try the next candidate path.
    }
  }
  return new Map();
}

/**
 * The bytes of one module's stream.
 *
 * Tries the UTF-16 stream name first, then the code-page one, then a
 * case-insensitive match. The order matters for non-Latin names: CFB stores
 * directory names as UTF-16, so the UTF-16 record matches them regardless of
 * which code pages the host's `TextDecoder` happens to support, while the
 * code-page name can decode to something that matches nothing.
 */
function readModuleStream(
  container: CfbContainer,
  storagePath: string,
  entry: DirModule,
  fallbackName: string,
): Uint8Array {
  const names = [entry.streamNameUnicode, entry.streamName, entry.nameUnicode, fallbackName];
  const tried = new Set<string>();

  for (const name of names) {
    if (!name || tried.has(name)) continue;
    tried.add(name);
    try {
      return container.readStream(`${storagePath}/${name}`);
    } catch {
      // Try the next spelling.
    }
  }

  // MS-CFB compares entry names case-insensitively, so a project whose
  // recorded stream name differs only in case is still valid.
  const wanted = [...tried].map((name) => `${storagePath}/${name}`.toLowerCase());
  const match = container.entries.find(
    (candidate) => candidate.type === 'stream' && wanted.includes(candidate.path.toLowerCase()),
  );
  if (match) return container.readStream(match.path);

  throw new VbaParseError('malformed', `OLE container: no stream for module ${fallbackName}`);
}

/**
 * The `dir` stream, by path. Word and Excel keep it under a `VBA` storage;
 * other producers use a different storage name, so a `VBA` parent is
 * preferred but not required.
 */
function findDirStream(container: CfbContainer): string | null {
  const candidates = container.entries.filter(
    (entry) => entry.type === 'stream' && entry.name.toLowerCase() === 'dir',
  );
  const preferred = candidates.find((entry) => /\/vba\/dir$/i.test(entry.path));
  return preferred?.path ?? candidates[0]?.path ?? null;
}

/* ------------------------------------------------------------------ *
 * .docm / .dotm packages
 * ------------------------------------------------------------------ */

const VBA_RELATIONSHIP_TYPE = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';
const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/**
 * Whether a Word package carries a macro project, and where.
 *
 * Returns the part's path inside the package, or `null`. Only the
 * relationship and content-type parts are read — nothing is decompressed from
 * the macro project itself — so this is the cheap question to ask when the
 * answer decides something other than what to display.
 *
 * The reason it exists separately: a document carrying a macro project must be
 * saved as `.docm`, and that decision has to hold even for a project too
 * damaged to read. Asking "did extraction succeed" would answer a different
 * question and quietly strip a user's macros on save.
 *
 * Never throws.
 */
export async function findVbaPart(docx: Uint8Array): Promise<string | null> {
  try {
    return await findVbaPartName(openZip(docx));
  } catch {
    return null;
  }
}

/**
 * Reads the VBA project out of a Word package (`.docm`, `.dotm`, or a `.docx`
 * that happens to carry one).
 *
 * Never throws; `reason: 'no-macros'` is the ordinary answer for a document
 * without macros. Any other failure still reports `partName` when a macro part
 * was located, so a caller can tell "no macros" from "macros we cannot read".
 */
export async function extractVbaFromDocx(docx: Uint8Array): Promise<VbaExtraction> {
  let archive: ZipArchive;
  try {
    archive = openZip(docx);
  } catch (error) {
    return toFailure(error, 'not-a-package');
  }

  let partName: string | null;
  try {
    partName = await findVbaPartName(archive);
  } catch (error) {
    return toFailure(error, 'unreadable');
  }
  if (!partName) {
    return { ok: false, reason: 'no-macros', message: 'The document contains no macro project.' };
  }

  try {
    const bin = await archive.read(partName);
    return extractVbaProject(bin, partName);
  } catch (error) {
    return toFailure(error, 'unreadable', partName);
  }
}

/**
 * Locates the macro part. The relationship graph is authoritative — the part
 * may legally be named anything, so matching on `vbaProject.bin` is only a
 * last resort for packages whose relationships are damaged.
 */
async function findVbaPartName(archive: ZipArchive): Promise<string | null> {
  const fromRelationships = await findVbaPartViaRelationships(archive);
  if (fromRelationships && archive.has(fromRelationships)) return fromRelationships;

  const fromContentTypes = await findVbaPartViaContentTypes(archive);
  if (fromContentTypes && archive.has(fromContentTypes)) return fromContentTypes;

  const byName = archive.entries.find((entry) => /(^|\/)vbaProject\.bin$/i.test(entry.name));
  return byName?.name ?? null;
}

async function findVbaPartViaRelationships(archive: ZipArchive): Promise<string | null> {
  const mainPart = await findMainDocumentPart(archive);
  if (!mainPart) return null;

  const slash = mainPart.lastIndexOf('/');
  const baseDir = slash < 0 ? '' : mainPart.slice(0, slash);
  const fileName = slash < 0 ? mainPart : mainPart.slice(slash + 1);
  const relsPath = `${baseDir ? `${baseDir}/` : ''}_rels/${fileName}.rels`;
  if (!archive.has(relsPath)) return null;

  const target = findRelationshipTarget(await readText(archive, relsPath), VBA_RELATIONSHIP_TYPE);
  return target ? resolvePartPath(baseDir, target) : null;
}

async function findMainDocumentPart(archive: ZipArchive): Promise<string | null> {
  if (!archive.has('_rels/.rels')) return null;
  const target = findRelationshipTarget(
    await readText(archive, '_rels/.rels'),
    OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  );
  return target ? resolvePartPath('', target) : null;
}

async function findVbaPartViaContentTypes(archive: ZipArchive): Promise<string | null> {
  if (!archive.has('[Content_Types].xml')) return null;
  const xml = await readText(archive, '[Content_Types].xml');

  for (const tag of findTags(xml, 'Override')) {
    if (!attribute(tag, 'ContentType')?.includes('vbaProject')) continue;
    const part = attribute(tag, 'PartName');
    if (part) return part.replace(/^\/+/, '');
  }

  // A `Default` mapping names an extension, not a part — so it only tells us
  // which entry to look for.
  for (const tag of findTags(xml, 'Default')) {
    if (!attribute(tag, 'ContentType')?.includes('vbaProject')) continue;
    const extension = attribute(tag, 'Extension');
    if (!extension) continue;
    const suffix = `.${extension.toLowerCase()}`;
    const match = archive.entries.find((entry) => entry.name.toLowerCase().endsWith(suffix));
    if (match) return match.name;
  }
  return null;
}

/**
 * The target of the first relationship of a given type.
 *
 * Hand-parsed rather than DOM-parsed because `DOMParser` does not exist in
 * Node, and a miss is safe — the caller falls back to another lookup.
 */
function findRelationshipTarget(xml: string, type: string): string | null {
  for (const tag of findTags(xml, 'Relationship')) {
    if (attribute(tag, 'Type') !== type) continue;
    // External targets point outside the package — never a macro part.
    if (attribute(tag, 'TargetMode')?.toLowerCase() === 'external') continue;
    const target = attribute(tag, 'Target');
    if (target) return target;
  }
  return null;
}

const XML_LIMITS = {
  /** How much of a package part is parsed as XML. Real `.rels` are tiny. */
  maxTextBytes: 1_000_000,
  maxTagLength: 2_048,
  maxTags: 5_000,
} as const;

/**
 * Every `<name …>` tag in the document, each bounded in length.
 *
 * Scanned with `indexOf` rather than a regex on purpose. The obvious pattern
 * for this job is `/<Relationship\b[^>]*>/g`, and it is quadratic: `[^>]*`
 * cannot match `>`, so on input full of `<Relationship` and containing no
 * `>` at all, every occurrence is a candidate start that consumes to the end
 * of the input and then backtracks a character at a time. A 60 MB part built
 * that way — which compresses to a few kilobytes inside a `.docm` — is hours
 * of wall-clock time in a frozen tab. `indexOf` has no backtracking, so this
 * is linear in the input no matter what the input is.
 */
function findTags(xml: string, name: string): string[] {
  const found: string[] = [];
  const needle = `<${name}`;
  let at = 0;

  while (found.length < XML_LIMITS.maxTags) {
    const start = xml.indexOf(needle, at);
    if (start < 0) break;
    at = start + needle.length;

    // The element name has to end here, so `<Relationship` does not match
    // `<Relationships`.
    const following = xml[at];
    if (following !== undefined && following !== '/' && following !== '>' && !/\s/.test(following)) {
      continue;
    }

    const end = xml.indexOf('>', at);
    if (end < 0) break;
    if (end - start <= XML_LIMITS.maxTagLength) found.push(xml.slice(start, end + 1));
    at = end + 1;
  }
  return found;
}

/**
 * One attribute's value from a single tag. Safe to run a regex here: the tag
 * is already bounded by `XML_LIMITS.maxTagLength`, and `name` is always a
 * literal from this file, never anything file-derived.
 */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match?.[1] ?? null;
}

/** Resolves a relationship target against the part's folder. */
function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const segments = baseDir ? baseDir.split('/') : [];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

async function readText(archive: ZipArchive, name: string): Promise<string> {
  // A tight cap, passed down so the reader abandons an oversized part while
  // decompressing instead of handing back megabytes of XML to scan.
  const bytes = await archive.read(name, { maxBytes: XML_LIMITS.maxTextBytes });
  return new TextDecoder('utf-8').decode(bytes);
}

/* ------------------------------------------------------------------ *
 * failures
 * ------------------------------------------------------------------ */

function toFailure(
  error: unknown,
  fallbackReason: VbaFailureReason,
  partName?: string,
): { ok: false; reason: VbaFailureReason; message: string; partName?: string } {
  const located = partName === undefined ? {} : { partName };
  if (isVbaParseError(error)) {
    const reason: VbaFailureReason =
      error.code === 'too-large' ? 'too-large' : error.code === 'unsupported' ? 'unsupported' : fallbackReason;
    return { ok: false, reason, message: error.message, ...located };
  }
  return {
    ok: false,
    reason: 'unreadable',
    message: error instanceof Error ? error.message : 'The macro project could not be read.',
    ...located,
  };
}
