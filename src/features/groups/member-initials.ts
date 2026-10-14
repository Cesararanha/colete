/** Up to two initials, first and last word, for the decorative member avatar. */
export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase('pt-BR');
}
