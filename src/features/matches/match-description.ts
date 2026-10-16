// The description rule of the form, the same as the Edge
// (supabase/functions/_shared/match-config.ts) and the database
// (private.normalize_match_description, 0022). match-description.test.ts runs
// both TypeScript copies over the same cases so they cannot drift apart.

export const DESCRIPTION_MAX = 500;

const FORBIDDEN = /[\p{Cc}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/**
 * NFC; LF kept (CR, CRLF, U+2028 and U+2029 become LF); other controls and
 * bidi marks refused; spaces collapse, spaces around a line feed and extra
 * blank lines go, the ends are trimmed. "" is null; empty after that is
 * refused, as is anything over 500 code points.
 */
export function normaliseDescription(
  value: string,
): { ok: true; value: string | null } | { ok: false; reason: 'blank' | 'control' | 'long' } {
  if (value === '') return { ok: true, value: null };
  const raw = value.normalize('NFC').replace(/\r\n?|[\u2028\u2029]/g, '\n');
  if (FORBIDDEN.test(raw.replaceAll('\n', ''))) return { ok: false, reason: 'control' };
  const text = raw
    .replace(/\p{Zs}+/gu, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \n]+|[ \n]+$/g, '');
  const length = [...text].length;
  if (length === 0) return { ok: false, reason: 'blank' };
  if (length > DESCRIPTION_MAX) return { ok: false, reason: 'long' };
  return { ok: true, value: text };
}

/** Code points the description will have once normalised, for the counter. */
export function descriptionLength(value: string): number {
  const result = normaliseDescription(value);
  if (result.ok) return result.value === null ? 0 : [...result.value].length;
  return [...value.normalize('NFC')].length;
}
