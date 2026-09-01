/**
 * A builder for synthetic `vbaProject.bin` files.
 *
 * The committed fixture is a genuine Office file, which is the right thing to
 * test the readers against — but its *content* is fixed, and several
 * behaviours cannot be reached with it: a Hebrew source in code page 1255, a
 * project whose macros Word would run on open, library references, and a
 * mini-allocation table with more entries than a small container needs.
 *
 * That last one is why this builder writes both storage layouts. A compound
 * file keeps streams under 4096 bytes in a packed "mini stream" with its own
 * allocation table, and in a real macro project almost everything — `dir`,
 * `PROJECT`, and every module of ordinary size — lives there. A builder that
 * could only write full sectors left that path tested by a single 12.8 KB
 * fixture, and a bound that was wrong for anything larger went unnoticed.
 *
 * Compression uses uncompressed windows only. A fixture must not depend on an
 * encoder of ours agreeing with the decoder under test — the token rules are
 * checked against hand-encoded vectors in `ms-ovba.test.ts` instead.
 */

const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const DIRECTORY_ENTRY_BYTES = 128;
const MINI_STREAM_CUTOFF = 4096;
const ENTRIES_PER_SECTOR = SECTOR_BYTES / 4;
const ENTRIES_PER_DIRECTORY_SECTOR = SECTOR_BYTES / DIRECTORY_ENTRY_BYTES;

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** [MS-OVBA] record ids the builder emits. */
const RECORD_CODE_PAGE = 0x0003;
const RECORD_PROJECT_VERSION = 0x0009;
const RECORD_REFERENCE_NAME = 0x0016;
const RECORD_REFERENCE_NAME_UNICODE = 0x003e;
const RECORD_REFERENCE_REGISTERED = 0x000d;
const RECORD_MODULE_NAME = 0x0019;
const RECORD_MODULE_STREAM_NAME = 0x001a;
const RECORD_MODULE_TYPE_PROCEDURAL = 0x0021;
const RECORD_MODULE_OFFSET = 0x0031;
const RECORD_MODULE_END = 0x002b;
const RECORD_TERMINATOR = 0x0010;

/**
 * Encodes text as windows-1255 (Hebrew). ASCII passes through and the Hebrew
 * block maps contiguously onto 0xE0-0xFA, which covers everything a test
 * needs; anything else would be a silent mistranslation, so it throws.
 */
export function encodeCp1255(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code >= 0x05d0 && code <= 0x05ea) {
      bytes.push(0xe0 + (code - 0x05d0));
    } else {
      throw new Error(`encodeCp1255: no mapping for U+${code.toString(16).toUpperCase()}`);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Wraps bytes in a CompressedContainer built entirely from uncompressed
 * windows: the 0x01 signature, then one header per 4096-byte window with the
 * compressed-chunk flag clear.
 */
export function ovbaUncompressedContainer(data: Uint8Array): Uint8Array {
  const out: number[] = [0x01];
  for (let at = 0; at < data.length; at += 4096) {
    const window = data.subarray(at, Math.min(at + 4096, data.length));
    // The size field holds the window's whole chunk length minus 3.
    const header = 0x3000 | (window.length - 1);
    out.push(header & 0xff, (header >> 8) & 0xff, ...window);
  }
  return Uint8Array.from(out);
}

function record(id: number, data: readonly number[]): number[] {
  return [
    id & 0xff,
    (id >> 8) & 0xff,
    data.length & 0xff,
    (data.length >> 8) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 24) & 0xff,
    ...data,
  ];
}

function padTo(bytes: Uint8Array, minimum: number, filler: number): Uint8Array {
  if (bytes.length >= minimum) return bytes;
  const padded = new Uint8Array(minimum);
  padded.fill(filler);
  padded.set(bytes, 0);
  return padded;
}

export interface SyntheticProjectOptions {
  codePage: number;
  moduleName: string;
  /** Source text already encoded in `codePage`. */
  source: Uint8Array;
  /** `PROJECT` stream lines, e.g. `Module=Module1`. */
  projectLines: readonly string[];
  /**
   * `'mini'` (the default) keeps the streams small so they land in the mini
   * stream, as a real project's do. `'sectors'` pads every stream past the
   * 4096-byte cutoff so they occupy full sectors instead.
   */
  layout?: 'mini' | 'sectors';
  /**
   * Whether to emit the library-reference records a project with `Tools ▸
   * References` entries carries. These are the records most likely to
   * desynchronize a directory walk, since several state their length in
   * unusual ways.
   */
  withReferences?: boolean;
  /**
   * Filler streams placed *before* the real ones, to push the real streams to
   * high mini-sector indices. Used to prove the mini allocation table is
   * bounded by mini sectors rather than by file sectors.
   */
  fillerStreams?: number;
  /**
   * Extra `MODULENAME` records naming modules that have no stream. Cheap to
   * write and cheap to compress — which is the point: they are how a small
   * file asks a reader to allocate a lot and complain a lot.
   */
  phantomModuleRecords?: number;
}

/** Builds a readable `vbaProject.bin` containing exactly one code module. */
export function buildVbaProjectBin(options: SyntheticProjectOptions): Uint8Array {
  const layout = options.layout ?? 'mini';
  const nameBytes = [...encodeCp1255(options.moduleName)];
  // With full sectors the source has to sit past the cutoff, which the module
  // stream reaches through its leading performance-cache area.
  const moduleTextOffset = layout === 'sectors' ? MINI_STREAM_CUTOFF : 64;

  const references = options.withReferences
    ? [
        ...record(RECORD_REFERENCE_NAME, [...encodeCp1255('stdole')]),
        ...record(RECORD_REFERENCE_NAME_UNICODE, [...utf16Bytes('stdole')]),
        ...record(RECORD_REFERENCE_REGISTERED, new Array<number>(40).fill(0x41)),
        ...record(RECORD_REFERENCE_NAME, [...encodeCp1255('Office')]),
        ...record(RECORD_REFERENCE_NAME_UNICODE, [...utf16Bytes('Office')]),
        ...record(RECORD_REFERENCE_REGISTERED, new Array<number>(72).fill(0x42)),
      ]
    : [];

  const dirRecords = [
    ...record(RECORD_CODE_PAGE, [options.codePage & 0xff, (options.codePage >> 8) & 0xff]),
    // Declares four bytes and carries six. Office writes it this way, and a
    // reader that trusts the declared size loses every record after it — so
    // the fixture reproduces the quirk on purpose.
    ...record(RECORD_PROJECT_VERSION, [0, 0, 0, 0]).slice(0, 6),
    0xff,
    0xff,
    0xff,
    0xff,
    0x00,
    0x00,
    ...references,
    ...Array.from({ length: options.phantomModuleRecords ?? 0 }).flatMap((_, index) => [
      ...record(RECORD_MODULE_NAME, [...encodeCp1255(`Ghost${index}`)]),
      ...record(RECORD_MODULE_OFFSET, u32Bytes(0)),
      ...record(RECORD_MODULE_END, []),
    ]),
    ...record(RECORD_MODULE_NAME, nameBytes),
    ...record(RECORD_MODULE_STREAM_NAME, nameBytes),
    ...record(RECORD_MODULE_OFFSET, u32Bytes(moduleTextOffset)),
    ...record(RECORD_MODULE_TYPE_PROCEDURAL, []),
    ...record(RECORD_MODULE_END, []),
    ...record(RECORD_TERMINATOR, []),
  ];

  const dirContent =
    layout === 'sectors'
      ? // Padding lands after the terminator, where a reader must already have
        // stopped. It exists only to push the stream past the cutoff.
        padTo(Uint8Array.from(dirRecords), MINI_STREAM_CUTOFF + 16, 0x00)
      : Uint8Array.from(dirRecords);
  const dirStream = ovbaUncompressedContainer(dirContent);

  // A real module stream opens with a performance cache the source follows,
  // which is what MODULEOFFSET points past.
  const container = ovbaUncompressedContainer(options.source);
  const moduleStream = new Uint8Array(moduleTextOffset + container.length);
  moduleStream.set(container, moduleTextOffset);

  const projectText = `${options.projectLines.join('\r\n')}\r\n`;
  const projectStream =
    layout === 'sectors'
      ? padTo(encodeCp1255(projectText), MINI_STREAM_CUTOFF + 16, 0x0a)
      : encodeCp1255(projectText);

  const filler: StreamSpec[] = Array.from({ length: options.fillerStreams ?? 0 }, (_, index) => ({
    // Named like the performance-cache streams Office itself writes, and
    // placed first so the real streams end up at high mini-sector indices.
    path: ['VBA', `__SRP_${index}`],
    data: new Uint8Array(1_024).fill(0x5a),
  }));

  return writeCompoundFile([
    ...filler,
    { path: ['VBA', 'dir'], data: dirStream },
    { path: ['VBA', options.moduleName], data: moduleStream },
    { path: ['PROJECT'], data: projectStream },
  ]);
}

function u32Bytes(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function utf16Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  return bytes;
}

/**
 * A compound file whose directory is a chain of storages nested one inside
 * the next — the shape that makes path strings grow quadratically with the
 * entry count. No streams: the walk itself is what is under test.
 */
export function buildNestedStorages(depth: number, nameLength = 31): Uint8Array {
  const directorySectorCount = Math.ceil((depth + 1) / ENTRIES_PER_DIRECTORY_SECTOR);
  const fatSectorCount = 1;
  const totalSectors = fatSectorCount + directorySectorCount;

  const file = new Uint8Array(SECTOR_BYTES + totalSectors * SECTOR_BYTES);
  const view = new DataView(file.buffer);
  const sectorAt = (sector: number): number => (sector + 1) * SECTOR_BYTES;

  file.set(CFB_SIGNATURE, 0);
  view.setUint16(26, 0x0003, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectorCount, true);
  view.setUint32(48, 1, true); // first directory sector
  view.setUint32(56, MINI_STREAM_CUTOFF, true);
  view.setUint32(60, ENDOFCHAIN, true);
  view.setUint32(64, 0, true);
  view.setUint32(68, ENDOFCHAIN, true);
  view.setUint32(72, 0, true);
  view.setUint32(76, 0, true); // DIFAT[0] → FAT sector 0
  for (let i = 1; i < 109; i += 1) view.setUint32(76 + i * 4, FREESECT, true);

  const fat = new Array<number>(ENTRIES_PER_SECTOR).fill(FREESECT);
  fat[0] = FATSECT;
  for (let i = 0; i < directorySectorCount; i += 1) {
    fat[1 + i] = i === directorySectorCount - 1 ? ENDOFCHAIN : 2 + i;
  }
  for (let i = 0; i < fat.length; i += 1) view.setUint32(sectorAt(0) + i * 4, fat[i]!, true);

  const name = 'S'.repeat(nameLength);
  for (let id = 0; id <= depth; id += 1) {
    const sector = 1 + Math.floor(id / ENTRIES_PER_DIRECTORY_SECTOR);
    const at = sectorAt(sector) + (id % ENTRIES_PER_DIRECTORY_SECTOR) * DIRECTORY_ENTRY_BYTES;
    const entryName = id === 0 ? 'Root Entry' : name;

    for (let c = 0; c < entryName.length; c += 1) {
      view.setUint16(at + c * 2, entryName.charCodeAt(c), true);
    }
    view.setUint16(at + 64, (entryName.length + 1) * 2, true);
    view.setUint8(at + 66, id === 0 ? 5 : 1); // root, then storages all the way down
    view.setUint8(at + 67, 1);
    view.setUint32(at + 68, NOSTREAM, true);
    view.setUint32(at + 72, NOSTREAM, true);
    // Each entry's only child is the next one — so every path is one segment
    // longer than the last.
    view.setUint32(at + 76, id < depth ? id + 1 : NOSTREAM, true);
    view.setUint32(at + 116, ENDOFCHAIN, true);
    view.setUint32(at + 120, 0, true);
    view.setUint32(at + 124, 0, true);
  }

  return file;
}

/* ------------------------------------------------------------------ *
 * ZIP writing — for the package-level adversarial cases
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFileEntry {
  name: string;
  data: Uint8Array;
  /** Store deflated rather than as-is. */
  deflate?: boolean;
  /**
   * Override the uncompressed size written to the headers. A decompression
   * bomb is exactly this: a small declared size over data that expands.
   */
  declaredSize?: number;
}

/** Writes a ZIP archive. Read-only readers are the thing under test, not this. */
export async function buildZip(entries: readonly ZipFileEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  // Entry payloads reach megabytes, so they are kept as chunks and joined at
  // the end. Spreading them into a number[] would blow the argument limit.
  const localChunks: Uint8Array[] = [];
  let localLength = 0;
  const central: number[] = [];
  const push32 = (into: number[], value: number): void => {
    into.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const push16 = (into: number[], value: number): void => {
    into.push(value & 0xff, (value >>> 8) & 0xff);
  };
  const emit = (bytes: Uint8Array): void => {
    localChunks.push(bytes);
    localLength += bytes.length;
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const stored = entry.deflate ? await deflateRaw(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const declared = entry.declaredSize ?? entry.data.length;
    const offset = localLength;

    const header: number[] = [];
    push32(header, 0x04034b50);
    push16(header, 20);
    push16(header, 0);
    push16(header, method);
    push16(header, 0);
    push16(header, 0);
    push32(header, crc);
    push32(header, stored.length);
    push32(header, declared);
    push16(header, name.length);
    push16(header, 0);
    emit(Uint8Array.from(header));
    emit(name);
    emit(stored);

    push32(central, 0x02014b50);
    push16(central, 20);
    push16(central, 20);
    push16(central, 0);
    push16(central, method);
    push16(central, 0);
    push16(central, 0);
    push32(central, crc);
    push32(central, stored.length);
    push32(central, declared);
    push16(central, name.length);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, 0);
    push32(central, offset);
    central.push(...name);
  }

  const eocd: number[] = [];
  push32(eocd, 0x06054b50);
  push16(eocd, 0);
  push16(eocd, 0);
  push16(eocd, entries.length);
  push16(eocd, entries.length);
  push32(eocd, central.length);
  push32(eocd, localLength);
  push16(eocd, 0);

  emit(Uint8Array.from(central));
  emit(Uint8Array.from(eocd));

  const out = new Uint8Array(localLength);
  let at = 0;
  for (const chunk of localChunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface StreamSpec {
  /** Path segments; a two-segment path puts the stream inside that storage. */
  path: readonly string[];
  data: Uint8Array;
}

interface PlannedEntry {
  name: string;
  type: 1 | 2 | 5;
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
}

/**
 * Writes a compound file holding the given streams, routing each to full
 * sectors or to the mini stream exactly as the format requires. Supports the
 * shape a VBA project needs: top-level streams plus one level of storage.
 */
function writeCompoundFile(streams: readonly StreamSpec[]): Uint8Array {
  const big = streams.filter((stream) => stream.data.length >= MINI_STREAM_CUTOFF);
  const small = streams.filter((stream) => stream.data.length < MINI_STREAM_CUTOFF);

  /* ---- mini stream and its allocation table ---- */

  let miniCursor = 0;
  const miniPlacements = small.map((stream) => {
    const start = miniCursor;
    const count = Math.max(1, Math.ceil(stream.data.length / MINI_SECTOR_BYTES));
    miniCursor += count;
    return { stream, start, count };
  });

  const miniStream = new Uint8Array(miniCursor * MINI_SECTOR_BYTES);
  for (const placement of miniPlacements) {
    miniStream.set(placement.stream.data, placement.start * MINI_SECTOR_BYTES);
  }

  const miniFatSectorCount = Math.ceil(miniCursor / ENTRIES_PER_SECTOR);
  const miniFat = new Array<number>(miniFatSectorCount * ENTRIES_PER_SECTOR).fill(FREESECT);
  for (const placement of miniPlacements) {
    for (let i = 0; i < placement.count; i += 1) {
      miniFat[placement.start + i] = i === placement.count - 1 ? ENDOFCHAIN : placement.start + i + 1;
    }
  }

  /* ---- directory entries ---- */

  const entries: PlannedEntry[] = [
    { name: 'Root Entry', type: 5, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, startSector: ENDOFCHAIN, size: 0 },
  ];
  const storageId = new Map<string, number>();
  for (const stream of streams) {
    if (stream.path.length < 2) continue;
    const storage = stream.path[0]!;
    if (storageId.has(storage)) continue;
    storageId.set(storage, entries.length);
    entries.push({
      name: storage,
      type: 1,
      left: NOSTREAM,
      right: NOSTREAM,
      child: NOSTREAM,
      startSector: ENDOFCHAIN,
      size: 0,
    });
  }

  const streamEntryId = new Map<StreamSpec, number>();
  const childrenOf = new Map<number, number[]>();
  const topLevel: number[] = [...storageId.values()];
  for (const stream of streams) {
    const id = entries.length;
    streamEntryId.set(stream, id);
    entries.push({
      name: stream.path[stream.path.length - 1]!,
      type: 2,
      left: NOSTREAM,
      right: NOSTREAM,
      child: NOSTREAM,
      startSector: ENDOFCHAIN,
      size: stream.data.length,
    });
    if (stream.path.length >= 2) {
      const parent = storageId.get(stream.path[0]!)!;
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id]);
    } else {
      topLevel.push(id);
    }
  }

  // The directory is a tree; a right-leaning chain is a legal (if unbalanced)
  // encoding of a sibling list, and it is what the reader has to cope with.
  const chainSiblings = (ids: readonly number[]): number => {
    for (let i = 0; i < ids.length - 1; i += 1) entries[ids[i]!]!.right = ids[i + 1]!;
    return ids[0] ?? NOSTREAM;
  };
  entries[0]!.child = chainSiblings(topLevel);
  for (const [parent, children] of childrenOf) entries[parent]!.child = chainSiblings(children);

  const directorySectorCount = Math.ceil(entries.length / ENTRIES_PER_DIRECTORY_SECTOR);

  /* ---- sector layout ---- */

  const sectorsFor = (byteLength: number): number => Math.ceil(byteLength / SECTOR_BYTES);
  const miniStreamSectors = sectorsFor(miniStream.length);
  const bigSectors = big.reduce((total, stream) => total + sectorsFor(stream.data.length), 0);
  const payloadSectors = directorySectorCount + miniFatSectorCount + miniStreamSectors + bigSectors;

  // How many FAT sectors are needed depends on the total, which includes them
  // — so it is resolved by iteration rather than guessed.
  let fatSectorCount = 1;
  while (fatSectorCount * ENTRIES_PER_SECTOR < payloadSectors + fatSectorCount) fatSectorCount += 1;

  let cursor = 0;
  const fatSectors = Array.from({ length: fatSectorCount }, () => cursor++);
  const directorySectors = Array.from({ length: directorySectorCount }, () => cursor++);
  const miniFatSectors = Array.from({ length: miniFatSectorCount }, () => cursor++);
  const miniStreamStart = cursor;
  cursor += miniStreamSectors;
  const bigPlacements = big.map((stream) => {
    const start = cursor;
    const count = sectorsFor(stream.data.length);
    cursor += count;
    return { stream, start, count };
  });
  const totalSectors = cursor;

  /* ---- allocation table ---- */

  const fat = new Array<number>(fatSectorCount * ENTRIES_PER_SECTOR).fill(FREESECT);
  const chainThrough = (sectors: readonly number[]): void => {
    for (let i = 0; i < sectors.length; i += 1) {
      fat[sectors[i]!] = i === sectors.length - 1 ? ENDOFCHAIN : sectors[i + 1]!;
    }
  };
  for (const sector of fatSectors) fat[sector] = FATSECT;
  chainThrough(directorySectors);
  chainThrough(miniFatSectors);
  chainThrough(Array.from({ length: miniStreamSectors }, (_, i) => miniStreamStart + i));
  for (const placement of bigPlacements) {
    chainThrough(Array.from({ length: placement.count }, (_, i) => placement.start + i));
  }

  /* ---- stream locations, now that sectors are assigned ---- */

  entries[0]!.startSector = miniStreamSectors > 0 ? miniStreamStart : ENDOFCHAIN;
  entries[0]!.size = miniStream.length;
  for (const placement of miniPlacements) {
    entries[streamEntryId.get(placement.stream)!]!.startSector = placement.start;
  }
  for (const placement of bigPlacements) {
    entries[streamEntryId.get(placement.stream)!]!.startSector = placement.start;
  }

  /* ---- bytes ---- */

  const file = new Uint8Array(SECTOR_BYTES + totalSectors * SECTOR_BYTES);
  const view = new DataView(file.buffer);
  const sectorAt = (sector: number): number => (sector + 1) * SECTOR_BYTES;

  file.set(CFB_SIGNATURE, 0);
  view.setUint16(24, 0x003e, true); // minor version
  view.setUint16(26, 0x0003, true); // major version 3 — 512-byte sectors
  view.setUint16(28, 0xfffe, true); // little-endian marker
  view.setUint16(30, 9, true); // sector shift
  view.setUint16(32, 6, true); // mini sector shift
  view.setUint32(44, fatSectorCount, true);
  view.setUint32(48, directorySectors[0] ?? ENDOFCHAIN, true);
  view.setUint32(56, MINI_STREAM_CUTOFF, true);
  view.setUint32(60, miniFatSectors[0] ?? ENDOFCHAIN, true);
  view.setUint32(64, miniFatSectorCount, true);
  view.setUint32(68, ENDOFCHAIN, true); // first DIFAT sector: none needed
  view.setUint32(72, 0, true);
  for (let i = 0; i < 109; i += 1) {
    view.setUint32(76 + i * 4, fatSectors[i] ?? FREESECT, true);
  }

  for (let i = 0; i < fat.length; i += 1) {
    const sector = fatSectors[Math.floor(i / ENTRIES_PER_SECTOR)]!;
    view.setUint32(sectorAt(sector) + (i % ENTRIES_PER_SECTOR) * 4, fat[i]!, true);
  }
  for (let i = 0; i < miniFat.length; i += 1) {
    const sector = miniFatSectors[Math.floor(i / ENTRIES_PER_SECTOR)]!;
    view.setUint32(sectorAt(sector) + (i % ENTRIES_PER_SECTOR) * 4, miniFat[i]!, true);
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const sector = directorySectors[Math.floor(i / ENTRIES_PER_DIRECTORY_SECTOR)]!;
    const at = sectorAt(sector) + (i % ENTRIES_PER_DIRECTORY_SECTOR) * DIRECTORY_ENTRY_BYTES;

    for (let c = 0; c < entry.name.length; c += 1) {
      view.setUint16(at + c * 2, entry.name.charCodeAt(c), true);
    }
    view.setUint16(at + 64, (entry.name.length + 1) * 2, true); // includes the terminator
    view.setUint8(at + 66, entry.type);
    view.setUint8(at + 67, 1); // black
    view.setUint32(at + 68, entry.left, true);
    view.setUint32(at + 72, entry.right, true);
    view.setUint32(at + 76, entry.child, true);
    view.setUint32(at + 116, entry.startSector, true);
    view.setUint32(at + 120, entry.size, true);
    view.setUint32(at + 124, 0, true);
  }

  if (miniStreamSectors > 0) file.set(miniStream, sectorAt(miniStreamStart));
  for (const placement of bigPlacements) {
    file.set(placement.stream.data, sectorAt(placement.start));
  }

  return file;
}
