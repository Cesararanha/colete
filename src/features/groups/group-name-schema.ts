import { z } from '../../lib/zod';

import { pt } from '../../lib/i18n/pt';

export const groupNameSchema = z.string().refine((value) => {
  const raw = value.normalize('NFC');
  if (/[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u.test(raw))
    return false;
  const name = raw.replace(/[\p{Zs}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  const length = [...name].length;
  return length >= 2 && length <= 40;
}, pt.groups.create.invalid);

export const groupCreationSchema = z.object({ name: groupNameSchema });
