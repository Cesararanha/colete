import type { MatchTeamPlayer } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

/** A removed account keeps its place but shows no identity. */
export function entryName(entry: MatchTeamPlayer): string {
  return entry.account_removed || entry.name === null
    ? pt.matches.detail.removedAccount
    : entry.name;
}

export function entryDetail(entry: MatchTeamPlayer): string {
  if (entry.account_removed) return '';
  const position =
    entry.position === null
      ? pt.matches.detail.noPosition
      : pt.matches.detail.positions[entry.position];
  return [entry.nickname, position, entry.is_viewer ? pt.matches.detail.you : null]
    .filter(Boolean)
    .join(' · ');
}
