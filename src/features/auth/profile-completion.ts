import type { ProfileInput, ProfilePatch } from '../../lib/api';
import { profileSchema } from './schemas';

/**
 * The first access: name plus the optional nickname, position, foot and
 * shirt number, with the components and rules of the profile edit. One
 * complete_profile call carries everything filled in; an optional field left
 * empty is simply not sent.
 */
export function completionInput(values: ProfilePatch): ProfileInput {
  const input: Record<string, unknown> = { name: values.name };
  for (const key of ['nickname', 'position', 'dominant_foot', 'shirt_number'] as const) {
    if (values[key] !== null && values[key] !== undefined) input[key] = values[key];
  }
  return profileSchema.parse(input);
}
