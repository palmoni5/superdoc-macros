/**
 * [MS-OVBA] decompression.
 *
 * The vectors here are hand-encoded from the format rules rather than
 * captured from a compressor of our own. That is the point: a round-trip
 * against our own encoder would pass even if both sides misread the spec the
 * same way, and the field-width rule (how many of a token's 16 bits are the
 * back-distance) is exactly the kind of detail two halves of one codebase
 * would happily agree to get wrong. Each expectation below is derived from
 * the written rule and annotated with the arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { decompressOvba } from '../src/import/ms-ovba.js';
import { VbaParseError } from '../src/import/errors.js';

/**
 * One chunk. The 12-bit size field holds the chunk's whole length (its own
 * two header bytes included) minus 3, so for `data` it is `data.length - 1`.
 * Bits 12-14 are the fixed 0b011 signature; bit 15 flags a token stream.
 */
function chunk(data: readonly number[], compressed: boolean): number[] {
  const header = (compressed ? 0x8000 : 0) | 0x3000 | (data.length - 1);
  return [header & 0xff, (header >> 8) & 0xff, ...data];
}

/** A CompressedContainer: the 0x01 signature byte, then chunks. */
function container(...chunks: number[][]): Uint8Array {
  return Uint8Array.from([0x01, ...chunks.flat()]);
}

const text = (bytes: Uint8Array): string => new TextDecoder('windows-1252').decode(bytes);
const codes = (value: string): number[] => [...value].map((character) => character.charCodeAt(0));

describe('decompressOvba', () => {
  it('rejects data that does not start with the container signature', () => {
    expect(() => decompressOvba(Uint8Array.from([0x02, 0x00, 0x00]))).toThrow(VbaParseError);
  });

  it('rejects a chunk whose fixed signature bits are wrong', () => {
    // Header 0x8005: compressed flag set, but bits 12-14 are 0b000.
    const bytes = Uint8Array.from([0x01, 0x05, 0x80, 0x00, 0x41]);
    expect(() => decompressOvba(bytes)).toThrow(/chunk signature/);
  });

  it('copies an uncompressed window verbatim', () => {
    const raw = Array.from({ length: 4096 }, (_, index) => index % 251);
    const output = decompressOvba(container(chunk(raw, false)));
    expect(output).toEqual(Uint8Array.from(raw));
  });

  it('walks every window, not just the first', () => {
    const first = Array.from({ length: 4096 }, () => 0x41);
    const second = Array.from({ length: 4096 }, () => 0x42);
    const output = decompressOvba(container(chunk(first, false), chunk(second, false)));
    expect(output).toHaveLength(8192);
    expect(output[0]).toBe(0x41);
    expect(output[4095]).toBe(0x41);
    expect(output[4096]).toBe(0x42);
  });

  it('emits literal bytes when a flag bit is clear', () => {
    // Flag byte 0x00 — all eight following tokens are single literals.
    const output = decompressOvba(container(chunk([0x00, ...codes('abcdefgh')], true)));
    expect(text(output)).toBe('abcdefgh');
  });

  it('expands a back-reference, including a run that overlaps itself', () => {
    // Three literals, then one back-reference. With 3 bytes in the window the
    // distance field is the minimum 4 bits wide, so:
    //   length = (token & 0x0FFF) + 3 = 6 + 3 = 9
    //   distance = (token >>> 12) + 1 = 2 + 1 = 3
    // Copying 9 bytes from 3 back re-reads what this same copy writes — the
    // format's way of spelling a repeating run.
    const flags = 0b00001000; // bits 0-2 literal, bit 3 reference
    const token = 0x2006;
    const output = decompressOvba(
      container(chunk([flags, ...codes('abc'), token & 0xff, token >> 8], true)),
    );
    expect(text(output)).toBe('abcabcabcabc');
  });

  it('widens the distance field once the window passes 16 bytes', () => {
    // 17 literals, then a back-reference. At 17 bytes decompressed the
    // distance needs 5 bits rather than 4, which moves the split:
    //   length = (0x8002 & 0x07FF) + 3 = 2 + 3 = 5
    //   distance = (0x8002 >>> 11) + 1 = 16 + 1 = 17
    // Reading it with the 4-bit split would give length 2 and distance 9 —
    // so this vector fails loudly if the rule is applied at a fixed width.
    const letters = codes('ABCDEFGHIJKLMNOPQ');
    const token = 0x8002;
    const data = [
      0x00,
      ...letters.slice(0, 8),
      0x00,
      ...letters.slice(8, 16),
      0b00000010, // literal, then reference
      letters[16]!,
      token & 0xff,
      token >> 8,
    ];
    const output = decompressOvba(container(chunk(data, true)));
    expect(text(output)).toBe('ABCDEFGHIJKLMNOPQABCDE');
  });

  it('refuses a back-reference that reaches behind its own window', () => {
    // A reference as the very first token: nothing has been decompressed in
    // this window, so no distance can be valid.
    expect(() => decompressOvba(container(chunk([0x01, 0x00, 0x00], true)))).toThrow(
      /before the start of the window/,
    );
  });

  it('fails closed instead of growing past the output cap', () => {
    const raw = Array.from({ length: 4096 }, () => 0x41);
    try {
      decompressOvba(container(chunk(raw, false)), { maxOutput: 10 });
      expect.unreachable('expected the cap to be enforced');
    } catch (error) {
      expect(error).toBeInstanceOf(VbaParseError);
      expect((error as VbaParseError).code).toBe('too-large');
    }
  });

  it('starts at the requested offset', () => {
    // Module streams put a performance cache before the compressed source, so
    // the container rarely starts at byte 0.
    const body = container(chunk([0x00, ...codes('hello')], true));
    const withPrefix = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, ...body]);
    expect(text(decompressOvba(withPrefix, { offset: 4 }))).toBe('hello');
  });

  it('rejects an offset that lies outside the stream', () => {
    expect(() => decompressOvba(Uint8Array.from([0x01, 0x00]), { offset: 99 })).toThrow(VbaParseError);
  });
});
