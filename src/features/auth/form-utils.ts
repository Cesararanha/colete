import type { FieldErrors, FieldValues, Path, UseFormSetFocus } from 'react-hook-form';

export function focusFirstInvalid<T extends FieldValues>(
  errors: FieldErrors<T>,
  setFocus: UseFormSetFocus<T>,
) {
  const first = Object.keys(errors)[0] as Path<T> | undefined;
  if (first !== undefined) setFocus(first);
}
