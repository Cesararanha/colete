import type { IconName } from '@/components/ui/AppIcon';
import type { ChipTone } from '@/components/ui/Chip';
import { pt } from '@/lib/i18n/pt';

/** The role in text: "Jogador" everywhere, on the group list as in a member list (UX-007). */
export function roleName(role: string, player: string) {
  if (role === 'owner') return pt.groups.list.owner;
  if (role === 'organizer') return pt.groups.list.organizer;
  return player;
}

// The role is always said in text; the icon only repeats it (docs/15).
export function roleIcon(role: string): IconName {
  if (role === 'owner') return 'award';
  if (role === 'organizer') return 'shield';
  return 'user';
}

/** Prévia aprovada: Dono in amber, Organizador in blue, Jogador neutral. */
export function roleTone(role: string): ChipTone {
  if (role === 'owner') return 'primary';
  if (role === 'organizer') return 'info';
  return 'neutral';
}
