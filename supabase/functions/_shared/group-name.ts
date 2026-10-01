// Shared name rule for create_group and rename_group (docs/13 §5.0.6).
import { validation } from './errors.ts';

export function normaliseGroupName(value: unknown): string {
  if (typeof value !== 'string') throw validation('name', 'must be a string');
  const raw = value.normalize('NFC');
  if (/[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u.test(raw)) {
    throw validation('name', 'contains a forbidden control character');
  }
  const name = raw.replace(/[\p{Zs}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  if ([...name].length < 2 || [...name].length > 40) {
    throw validation('name', 'must be between 2 and 40 code points');
  }
  return name;
}
