/**
 * The typed name unlocks "Apagar grupo" when it is the group's name as the
 * person reads it: composed the same way, without the spaces around it or
 * doubled inside it, and in any case, since a phone keyboard may capitalise
 * the first letter. It only guards the button; the server decides alone.
 */
export function deleteConfirmed(typed: string, name: string): boolean {
  const fold = (value: string) =>
    value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('pt-BR');
  return fold(name) !== '' && fold(typed) === fold(name);
}
