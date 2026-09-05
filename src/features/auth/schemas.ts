import { z } from 'zod';

const requiredMessage = 'required';

export const emailSchema = z
  .string()
  .trim()
  .min(1, requiredMessage)
  .email('email')
  .transform((value) => value.toLocaleLowerCase('pt-BR'));

export const passwordSchema = z.string().min(8, 'password_length');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, requiredMessage),
});

export const signUpSchema = z
  .object({
    name: z.string().trim().min(2, 'name_length'),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string().min(1, requiredMessage),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword) {
      context.addIssue({ code: 'custom', message: 'password_match', path: ['confirmPassword'] });
    }
  });

export const otpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/u, 'otp_length'),
});

export const forgotEmailSchema = z.object({ email: emailSchema });

export const newPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(1, requiredMessage),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword) {
      context.addIssue({ code: 'custom', message: 'password_match', path: ['confirmPassword'] });
    }
  });

export const profileSchema = z.object({
  name: z.string().trim().min(2, 'name_length').max(80, 'name_max'),
  nickname: z.string().trim().min(1, 'optional_blank').max(30, 'nickname_max').optional(),
  position: z.enum(['goalkeeper', 'defender', 'midfielder', 'forward']).optional(),
  dominant_foot: z.enum(['left', 'right', 'both']).optional(),
  shirt_number: z.number().int().min(0).max(99).optional(),
});

export type LoginValues = z.input<typeof loginSchema>;
export type SignUpValues = z.input<typeof signUpSchema>;
export type OtpValues = z.input<typeof otpSchema>;
export type ForgotEmailValues = z.input<typeof forgotEmailSchema>;
export type NewPasswordValues = z.input<typeof newPasswordSchema>;
export type ProfileValues = z.input<typeof profileSchema>;

export type PasswordStrength = 'strong' | 'medium' | 'short';

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < 8) return 'short';
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((pattern) =>
    pattern.test(password),
  ).length;
  return password.length >= 12 && classes >= 3 ? 'strong' : 'medium';
}
