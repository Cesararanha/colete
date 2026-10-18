import type { MatchOccupancy, MatchSummary } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

/** The tone of a card's chip and bar (prévia aprovada); the chip always says it in words. */
export type MatchCardTone = 'positive' | 'warning' | 'info';

export type MatchCardState = {
  /** null: no chip (occupancy not read yet, or a full match the viewer is out of). */
  chip: { tone: MatchCardTone; label: string; icon?: 'check' | 'clock' } | null;
  bar: MatchCardTone | null;
  full: boolean;
  ratio: number;
};

/**
 * Green "Você vai" for a confirmed viewer, orange "Na espera" for the
 * waitlist, blue "N vagas abertas" while there is room, and no chip on a full
 * match the viewer is out of: the count then reads "Lotado". The contract has
 * no cancelled match and no waitlist position on the list read, so neither
 * appears here.
 */
export function matchCardState(
  occupancy: MatchOccupancy | undefined,
  slots: number,
): MatchCardState {
  if (!occupancy) return { bar: null, chip: null, full: false, ratio: 0 };
  const confirmed = occupancy.confirmed_count;
  const full = confirmed >= slots;
  const ratio = Math.min(1, confirmed / Math.max(1, slots));
  if (occupancy.viewer_status === 'starter') {
    return {
      bar: 'positive',
      chip: { icon: 'check', label: pt.matches.card.youGo, tone: 'positive' },
      full,
      ratio,
    };
  }
  if (occupancy.viewer_status === 'waitlist') {
    return {
      bar: 'warning',
      chip: { icon: 'clock', label: pt.matches.card.onWaitlist, tone: 'warning' },
      full,
      ratio,
    };
  }
  if (full) return { bar: 'warning', chip: null, full, ratio };
  return {
    bar: 'info',
    chip: { label: pt.matches.card.openSlots(slots - confirmed), tone: 'info' },
    full,
    ratio,
  };
}

export type MatchFilter = 'all' | 'playing' | 'open';

/** "Vou jogar": on the list, confirmed or waiting. "Com vaga": a slot is still open. */
export function matchPassesFilter(
  filter: MatchFilter,
  match: Pick<MatchSummary, 'field_slots'>,
  occupancy: MatchOccupancy | undefined,
): boolean {
  if (filter === 'all') return true;
  if (!occupancy) return false;
  if (filter === 'playing') return occupancy.viewer_status !== 'out';
  return occupancy.confirmed_count < match.field_slots;
}

function localDay(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'numeric',
    timeZone,
    weekday: 'short',
    year: 'numeric',
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(value('weekday'));
  const day =
    Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day'))) / 86_400_000;
  return { day, weekday };
}

export type MatchWeek = 'this' | 'next' | 'later';

/**
 * The week of a match, Monday to Sunday, both dates read in the match's own
 * time zone: "Esta semana", "Próxima semana" or later.
 */
export function matchWeek(startsAt: string, timeZone: string, now: Date): MatchWeek {
  const match = localDay(startsAt, timeZone);
  const today = localDay(now.toISOString(), timeZone);
  const weeks = Math.floor((match.day - match.weekday - (today.day - today.weekday)) / 7);
  if (weeks <= 0) return 'this';
  return weeks === 1 ? 'next' : 'later';
}

/** The match ends on a later local day than it starts: the card adds "(+1 dia)". */
export function endsNextDay(startsAt: string, endsAt: string, timeZone: string): boolean {
  return localDay(endsAt, timeZone).day > localDay(startsAt, timeZone).day;
}

/** How many of the listed matches start within the next seven days. */
export function matchesInNextWeek(matches: readonly Pick<MatchSummary, 'starts_at'>[], now: Date) {
  const limit = now.getTime() + 7 * 86_400_000;
  return matches.filter((match) => new Date(match.starts_at).getTime() <= limit).length;
}
