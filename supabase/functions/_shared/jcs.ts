// JSON Canonicalization Scheme, RFC 8785, restricted to what this gateway may
// send. docs/13-contratos-funcoes.md section 0.1 requires the canonical form to
// be byte-identical on both sides of the HMAC, so nothing here is allowed to be
// approximate.
//
// The restriction is deliberate: floats, NaN and Infinity are rejected rather
// than serialised. RFC 8785 defines a serialisation for them, but the contract
// forbids them as input, and a canonicaliser that quietly accepts what the
// contract rejects would move the refusal to a place nobody is looking at.

export class CanonicalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalisationError';
  }
}

// The safe integer range of docs/13 section 0.1.
const MAX_SAFE = 9007199254740991;

function serialiseNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalisationError('non-finite number');
  }
  if (!Number.isInteger(value)) {
    throw new CanonicalisationError('non-integer number');
  }
  if (Math.abs(value) > MAX_SAFE) {
    throw new CanonicalisationError('integer outside the safe range');
  }
  // Integers inside the safe range: ECMAScript Number::toString and the
  // RFC 8785 form agree, and neither produces an exponent here.
  return String(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value === true ? 'true' : 'false';
  if (type === 'number') return serialiseNumber(value as number);
  // JSON.stringify implements exactly the RFC 8785 string production: the six
  // short escapes, \u00xx for the remaining control characters, and every other
  // code point literal as UTF-8.
  if (type === 'string') return JSON.stringify(value as string);

  if (Array.isArray(value)) {
    return '[' + value.map((item) => serialise(item)).join(',') + ']';
  }

  if (type === 'object') {
    const record = value as Record<string, unknown>;
    // RFC 8785 orders members by their UTF-16 code units, which is what the
    // default comparison of Array.prototype.sort does for strings.
    const keys = Object.keys(record).sort();
    const members = keys.map((key) => {
      const member = record[key];
      if (member === undefined) {
        throw new CanonicalisationError('undefined member');
      }
      return JSON.stringify(key) + ':' + serialise(member);
    });
    return '{' + members.join(',') + '}';
  }

  throw new CanonicalisationError('unserialisable value');
}

/** Canonical JSON text of a value, per RFC 8785. */
export function canonicalise(value: unknown): string {
  return serialise(value);
}

/** Canonical JSON of a value, encoded as UTF-8 without a byte order mark. */
export function canonicaliseToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalise(value));
}
