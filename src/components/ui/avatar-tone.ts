import type { ThemeColors } from '../../theme/colors';

/** The five avatar tones of the prévia aprovada: fill and initials, as token names. */
export const AVATAR_TONES = [
  { fill: 'avatar', text: 'text' },
  { fill: 'positiveSoft', text: 'positive' },
  { fill: 'warningSoft', text: 'warning' },
  { fill: 'accentSoft', text: 'accent' },
  { fill: 'infoSoft', text: 'info' },
] as const satisfies readonly { fill: keyof ThemeColors; text: keyof ThemeColors }[];

/**
 * The tone of a person, fixed by their profile id (FNV-1a over the id), so
 * the same person has the same colour on every screen and every device. The
 * colour is decoration only: the name is always written beside the avatar.
 */
export function avatarTone(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_TONES.length;
}
