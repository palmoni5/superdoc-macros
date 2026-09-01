/**
 * [MS-OVBA] 2.4.1 — the run-length/LZ hybrid VBA sources are stored under.
 *
 * VBA module text inside `vbaProject.bin` is never plain text: each stream
 * holds a *CompressedContainer* built from 4096-byte windows, where each
 * window is either raw or a token stream of literals and back-references.
 * Decompressing it is the whole difference between "we found a macro" and
 * "we can show the user their macro".
 *
 * Two properties matter here beyond correctness:
 *
 * - **Bounded output.** A back-reference can repeat data, so a small input
 *   can describe a large output. Every call carries a hard output cap; the
 *   decoder fails closed rather than growing until the tab dies.
 * - **No trust in offsets.** Every read is bounds-checked and raises
 *   `VbaParseError`, so a truncated or hostile file cannot produce a stray
 *   `RangeError` from deep inside a loop.
 */
import { VbaParseError } from './errors.js';

export const OVBA_LIMITS = {
  /**
   * Cap on the decompressed size of a single stream. Real VBA modules are
   * kilobytes; megabytes already means something is wrong.
   */
  maxDecompressedBytes: 20_000_000,
} as const;

/** A decompressed window is fixed at 4096 bytes by the format. */
const CHUNK_DECOMPRESSED_SIZE = 4096;
const SIGNATURE_BYTE = 0x01;
/** Bits 12-14 of a chunk header are a fixed 0b011. */
const CHUNK_SIGNATURE = 0x3;

/**
 * A growable output buffer that enforces the cap while it grows and supports
 * the overlapping self-copy a back-reference needs (copying byte by byte, so
 * a reference may legitimately read bytes this same copy just wrote).
 */
class ByteSink {
  private buffer: Uint8Array;
  private length = 0;

  constructor(private readonly max: number) {
    this.buffer = new Uint8Array(Math.min(4096, Math.max(max, 1)));
  }

  get size(): number {
    return this.length;
  }

  push(byte: number): void {
    this.reserve(1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  /**
   * Copies `count` bytes starting `distance` bytes back from the end — the
   * back-reference primitive. Byte-at-a-time on purpose: when
   * `count > distance` the copy reads its own fresh output, which is how the
   * format expresses a repeating run.
   *
   * `windowStart` is the floor the format imposes: a reference may not reach
   * back past the start of its own 4096-byte window. Enforcing that turns a
   * desynchronized decode into a clean error instead of plausible-looking
   * garbage stitched together from an earlier window.
   */
  copyBack(distance: number, count: number, windowStart: number): void {
    if (distance <= 0 || distance > this.length - windowStart) {
      throw new VbaParseError('malformed', 'VBA stream: back-reference points before the start of the window');
    }
    this.reserve(count);
    let from = this.length - distance;
    for (let written = 0; written < count; written += 1) {
      // Bounded by construction: `from` starts inside the buffer and only
      // ever trails `this.length`, which `reserve` already made room for.
      this.buffer[this.length] = this.buffer[from]!;
      this.length += 1;
      from += 1;
    }
  }

  /** A copy, not a view — the caller keeps it after the sink is discarded. */
  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.max) {
      throw new VbaParseError(
        'too-large',
        `VBA stream: decompressed output exceeds the ${this.max}-byte cap`,
      );
    }
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(Math.min(capacity, this.max));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}

export interface DecompressOvbaOptions {
  /** Where the CompressedContainer starts. Module streams prefix it with a header. */
  offset?: number;
  /** Output cap in bytes. Default: `OVBA_LIMITS.maxDecompressedBytes`. */
  maxOutput?: number;
}

/**
 * Decompresses one CompressedContainer.
 *
 * @throws {VbaParseError} on a malformed container or one whose output would
 * exceed the cap. Never throws anything else.
 */
export function decompressOvba(source: Uint8Array, options: DecompressOvbaOptions = {}): Uint8Array {
  const start = options.offset ?? 0;
  // Sanitized rather than trusted: a host computing this from a setting can
  // hand us NaN, and `NaN > max` is false, so an unsanitized cap would
  // disable itself and then hang the growth loop.
  const requested = options.maxOutput;
  const max =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : OVBA_LIMITS.maxDecompressedBytes;

  if (!Number.isInteger(start) || start < 0 || start >= source.length) {
    throw new VbaParseError('malformed', 'VBA stream: compressed data starts past the end of the stream');
  }
  const byteAt = (index: number): number => {
    const byte = source[index];
    if (byte === undefined) {
      throw new VbaParseError('malformed', 'VBA stream: truncated compressed data');
    }
    return byte;
  };

  if (byteAt(start) !== SIGNATURE_BYTE) {
    throw new VbaParseError('malformed', 'VBA stream: missing the 0x01 compressed-container signature');
  }

  const sink = new ByteSink(max);
  let cursor = start + 1;

  while (cursor < source.length) {
    // A trailing single byte cannot be a chunk header. Treat it as padding
    // rather than a hard failure: real files pad, and the content we already
    // decoded is intact and useful.
    if (cursor + 1 >= source.length) break;

    const chunkStart = cursor;
    const header = byteAt(cursor) | (byteAt(cursor + 1) << 8);
    cursor += 2;

    const signature = (header >> 12) & 0x7;
    if (signature !== CHUNK_SIGNATURE) {
      // Deliberately fatal, even though bytes have already been decoded.
      // Returning the partial text would hand the caller a module whose tail
      // is missing with nothing to say so — and this text exists to be read
      // and ported by a human, who would not notice. A module reported as
      // unreadable is a worse result but an honest one.
      throw new VbaParseError('malformed', 'VBA stream: bad chunk signature');
    }

    // The 12-bit size field stores the whole chunk length (header included)
    // minus 3.
    const chunkLength = (header & 0x0fff) + 3;
    const chunkEnd = Math.min(chunkStart + chunkLength, source.length);
    const compressed = (header & 0x8000) !== 0;

    if (!compressed) {
      for (let i = 0; i < CHUNK_DECOMPRESSED_SIZE && cursor < chunkEnd; i += 1) {
        sink.push(byteAt(cursor));
        cursor += 1;
      }
      cursor = chunkEnd;
      continue;
    }

    // Back-reference distances are relative to the start of *this* window,
    // and the split between length and distance bits depends on how much of
    // the window has been produced so far — so the window origin must be
    // tracked, not assumed to be the start of the output.
    const windowStart = sink.size;

    while (cursor < chunkEnd) {
      const flags = byteAt(cursor);
      cursor += 1;

      for (let bit = 0; bit < 8 && cursor < chunkEnd; bit += 1) {
        const isReference = (flags & (1 << bit)) !== 0;

        if (!isReference) {
          sink.push(byteAt(cursor));
          cursor += 1;
          continue;
        }

        // Both bytes are read unconditionally: [MS-OVBA] 2.4.1.3.19 bounds
        // the *token sequence*, not the token, so a token whose second byte
        // sits on the chunk boundary is still a token. Only running off the
        // end of the stream is an error, which `byteAt` reports.
        const token = byteAt(cursor) | (byteAt(cursor + 1) << 8);
        cursor += 2;

        // [MS-OVBA] 2.4.1.3.19.1: the field split is driven by how far into
        // the window we are — the fewer bytes produced, the fewer bits a
        // distance needs, and the more are left for the length.
        const produced = sink.size - windowStart;
        if (produced > CHUNK_DECOMPRESSED_SIZE) {
          // A window cannot exceed 4096 bytes, so the distance field cannot
          // need more than 12 bits. Past that the split is undefined and any
          // answer would be a guess — fail closed instead.
          throw new VbaParseError('malformed', 'VBA stream: window grew past its 4096-byte limit');
        }
        let distanceBits = 4;
        while (distanceBits < 12 && 1 << distanceBits < produced) distanceBits += 1;

        const lengthMask = 0xffff >> distanceBits;
        const length = (token & lengthMask) + 3;
        const distance = (token >>> (16 - distanceBits)) + 1;

        sink.copyBack(distance, length, windowStart);
      }
    }

    cursor = chunkEnd;
  }

  return sink.toBytes();
}
