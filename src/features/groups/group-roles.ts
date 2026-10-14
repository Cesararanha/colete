import type { IconName } from '@/components/ui/AppIcon';
import { pt } from '@/lib/i18n/pt';

/** The role in text. A player reads "Membro" on the group list and "Jogador" in a member list. */
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
