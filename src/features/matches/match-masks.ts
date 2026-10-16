// Masks applied while the person types, with no dependency: the field keeps
// the formatted text, and match-form.ts reads the same text back. Each mask
// keeps only digits and rebuilds the separators, so deleting a character
// never leaves a separator stranded.

function digits(value: string, max: number): string {
  return value.replace(/\D/gu, '').slice(0, max);
}

/** "18102026" → "18/10/2026"; partial input stays partial: "181" → "18/1". */
export function maskDate(value: string): string {
  const typed = digits(value, 8);
  if (typed.length <= 2) return typed;
  if (typed.length <= 4) return `${typed.slice(0, 2)}/${typed.slice(2)}`;
  return `${typed.slice(0, 2)}/${typed.slice(2, 4)}/${typed.slice(4)}`;
}

/** "1930" → "19:30"; "19" stays "19". */
export function maskTime(value: string): string {
  const typed = digits(value, 4);
  return typed.length <= 2 ? typed : `${typed.slice(0, 2)}:${typed.slice(2)}`;
}

/**
 * Reais typed as cents, from the right, up to R$ 9.999,99: "2500" →
 * "R$ 25,00", "5" → "R$ 0,05". Leading zeros go; nothing typed stays "".
 * A plain space, not the no-break space Intl would put after "R$".
 */
export function maskMoney(value: string): string {
  const typed = digits(value, 6).replace(/^0+/u, '');
  if (typed === '') return '';
  const cents = typed.padStart(3, '0');
  const reais = cents.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  return `R$ ${reais},${cents.slice(-2)}`;
}
