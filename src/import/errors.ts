/**
 * The one error type the binary readers raise.
 *
 * The readers parse files that arrive from users — a `.docm` someone was
 * emailed. Every structural surprise must land as a typed, catchable failure
 * rather than a `RangeError` from a stray offset, so the public extraction
 * API can convert it into a message and never throw at its caller.
 */

export type VbaParseErrorCode =
  /** The bytes do not match the format, or a structure points outside the file. */
  | 'malformed'
  /** Structurally valid but beyond a safety cap — see the `*_LIMITS` objects. */
  | 'too-large'
  /** A format feature this reader deliberately does not implement. */
  | 'unsupported';

export class VbaParseError extends Error {
  readonly code: VbaParseErrorCode;

  constructor(code: VbaParseErrorCode, message: string) {
    super(message);
    this.name = 'VbaParseError';
    this.code = code;
  }
}

/** Whether an unknown thrown value is one of ours. */
export function isVbaParseError(error: unknown): error is VbaParseError {
  return error instanceof VbaParseError;
}
