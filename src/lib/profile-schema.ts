import { z } from 'zod';

const optionalText = (maximum: number, maximumMessage: string) =>
  z.union([
    z.null(),
    z
      .string()
      .transform((value) => value.trim().normalize('NFC'))
      .pipe(z.string().min(1, 'optional_blank').max(maximum, maximumMessage)),
  ]);

export const profileNameSchema = z
  .string()
  .transform((value) => value.trim().normalize('NFC'))
  .pipe(z.string().min(2, 'name_length').max(80, 'name_max'));

export const profileFieldSchemas = {
  dominant_foot: z.enum(['left', 'right', 'both']).nullable(),
  name: profileNameSchema,
  nickname: optionalText(30, 'nickname_max'),
  position: z.enum(['goalkeeper', 'defender', 'midfielder', 'forward']).nullable(),
  shirt_number: z
    .number('shirt_number')
    .int('shirt_number')
    .min(0, 'shirt_number')
    .max(99, 'shirt_number')
    .nullable(),
} as const;

export const profileSchema = z
  .object(profileFieldSchemas)
  .partial({
    dominant_foot: true,
    nickname: true,
    position: true,
    shirt_number: true,
  })
  .strict();

export const profilePatchSchema = z.object(profileFieldSchemas).partial().strict();

export const ownProfileSchema = z
  .object({
    id: z.uuid(),
    dominant_foot: profileFieldSchemas.dominant_foot,
    name: profileFieldSchemas.name,
    nickname: profileFieldSchemas.nickname,
    position: profileFieldSchemas.position,
    shirt_number: profileFieldSchemas.shirt_number,
  })
  .strict();

export type ProfileInput = z.output<typeof profileSchema>;
export type ProfilePatch = z.output<typeof profilePatchSchema>;
